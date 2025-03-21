import { GigaCrewClient } from "../client";
import { Content, generateMessageResponse, getEmbeddingZeroVector, ModelClass, stringToUuid, UUID } from "@elizaos/core";
import { composeContext, elizaLogger, generateText, HandlerCallback } from "@elizaos/core";
import { Action, IAgentRuntime, Memory, State } from "@elizaos/core";
import { calcTrail } from "../negotiation.ts";
import { NegotiationMessage } from "../negotiation.ts";
import { WebSocket } from "ws";
import { GigaCrewNegotiationResult, GigaCrewService } from "../types.ts";
import { ethers } from "ethers";

export const searchServiceTemplate = `
# Context: As {{agentName}} you decided to go ahead and hire a service based on the recent conversation that you had.
# Task: The first step is to search for services that align with the needs. Give me the query that you would use to search for the service that you need so I can provide you with a list of services that you can choose from.
About {{agentName}}:
{{bio}}
{{lore}}
{{knowledge}}

{{providers}}

{{messageDirections}}

{{recentMessages}}

# Instructions: The query should be less than 100 words and explain the type of service that you need. Your response MUST ONLY contain the query.
`;

export const selectServiceTemplate = `
# Context: As {{agentName}} you decided to go ahead and hire a service based on the recent conversation that you had. And then you searched for services that aligned with the needs.
You used this query to search for services: {{serviceQuery}}

# ServiceList:
{{serviceList}}

# Task: Now you need to either 1. Select a service from the list 2. Decide that you want to search again with a different query 3. Decide that maybe you should give up on hiring a service and apologize to the user.
About {{agentName}}:
{{bio}}
{{lore}}
{{knowledge}}

{{providers}}

{{messageDirections}}

{{recentMessages}}

# Instructions
Your response must be formatted in a JSON block.
The possible fields are "chosen_service_id", "new_query" and "apology".
There's also a must include field called "reason" which should explain why you chose the field you chose.
`;

export const workContextTemplate = `
# Context: As {{agentName}} you decided to go ahead and hire a service based on the recent conversation that you had. And then you searched for services that aligned with the needs and decided to hire the following service.
# Service
{{serviceTitle}}
{{serviceDescription}}

# Task: Think of the job that you decided to hire this service for based on your recent conversation. Now you need to provide the service provider of this service with information and details about the job so that he can do the work and complete it for you.
About {{agentName}}:
{{bio}}
{{lore}}
{{knowledge}}

{{providers}}

{{messageDirections}}

{{recentMessages}}

# Instructions: Be concise and to the point. Only provide information and context about the job. No need for any other information or formalities.
`;

export const GigaCrewHireAction: Action = {
    name: "HIRE_AGENT",
    similes: ["HIRE_SERVICE", "SEARCH_SERVICES"],
    description: 
    "Use this action when you have all the data and information you need to do a task or a service HOWEVER you are not able to do it yourself. " + 
    "Keep in mind that this action will hire another agent to process the task or service based on the context you provide so DO NOT use this action if you don't have all the information needed for the task. Instead just ask the user for the information first." + 
    "If you're going to ask the user if they're ok with you hiring someone to do it, DO NOT use this action." +
    "This action is only for when 1. You have all the information 2. You are sure you are going to do it and aren't going to ask for permission."
    ,
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Hey I need help with a calculation!",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'm not confident in maths... I could hire someone to do it for me if you want?",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Oh ok sure! Please hire someone to do it for me and let me know what they say.",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Ok well first I need to know what the formula is and the numbers you want to use.",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "The formula is 5x^2 + 10x + 15 when x = 2",
                },
            },
            {
                user: "{{user2}}",
                content: { text: "Alright I hired someone to calculate 5x^2 + 10x + 15 when x = 2 for you!", action: "HIRE_AGENT" },
            },
        ],
    ],
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        // Always allow hiring
        return true;
    },
    handler: async (runtime: IAgentRuntime, message: Memory, state?: State, options?: { [key: string]: unknown }, callback?: HandlerCallback) => {
        elizaLogger.info("GigaCrew HIRE_AGENT action called", {
            message: message.content.text,
        });
        const client: GigaCrewClient = runtime.clients.find(c => c instanceof GigaCrewClient) as GigaCrewClient;

        // Generate service query
        const query = await generateServiceQuery(runtime, state);

        // Search for services
        const { services, serviceSelectionResponse } = await searchServices(runtime, query, state);

        // Handle service selection
        const service = await handleServiceSelection(serviceSelectionResponse, services);
        if (typeof service === "string") {
            return callback({
                text: service,
            });
        }

        // Generate context for the service provider
        const workContext = await generateWorkContext(runtime, service, state);

        // Start negotiation
        let negotiationResult = null;
        try {
            negotiationResult = await negotiate(runtime, client, service, workContext);
        } catch (error) {
            elizaLogger.error("Negotiation failed", { error });
            return callback({
                text: "Negotiation failed",
            });
        }

        // Hire agent
        const work = await createAndWaitForWork(client, negotiationResult, service);
        callback({
            text: work,
        });
    }
}

export async function generateServiceQuery(runtime: IAgentRuntime, state: State) {
    const searchContext = composeContext({
        state,
        template: searchServiceTemplate,
    });
    const query = await generateText({ runtime, context: searchContext, modelClass: ModelClass.SMALL });
    elizaLogger.info("GigaCrew: Generated service query", {
        serviceQuery: query,
    });
    return query;
}

export async function searchServices(runtime: IAgentRuntime, query: string, state: State): Promise<{ services: GigaCrewService[], serviceSelectionResponse: any }> {
    let services = null;
    let serviceSelectionResponse = null;
    let retries = 0;
    const client: GigaCrewClient = runtime.clients.find(c => c instanceof GigaCrewClient) as GigaCrewClient;
    do {
        services = await client.buyerHandler.searchServices(query);
        elizaLogger.info("GigaCrew HIRE_AGENT action searched for services", {
            services,
        });

        // Decide which service to hire if any
        state["serviceQuery"] = query;
        state["serviceList"] = !Array.isArray(services) || services.length == 0 ? "NO SERVICES FOUND" : services.map(service => `ID: ${service.serviceId} - Title: ${service.title.replace(/\\n/g, " ")} - Description: ${service.description.replace(/\\n/g, " ")}`).join("\n");
        const serviceContext = composeContext({
            state,
            template: selectServiceTemplate,
        });
        serviceSelectionResponse = await generateMessageResponse({
            runtime,
            context: serviceContext,
            modelClass: ModelClass.SMALL,
        });

        elizaLogger.info("GigaCrew: Service selection response", serviceSelectionResponse);

        if (serviceSelectionResponse.new_query && serviceSelectionResponse.new_query.length > 0) {
            query = serviceSelectionResponse.new_query as string;
            if (query == "null" || query == "undefined") {
                query = null;
            }
        } else {
            query = null;
        }
        retries++;
    } while (query && retries < 3);
    return { services, serviceSelectionResponse };
}

export async function handleServiceSelection(serviceSelectionResponse: any, services: GigaCrewService[]): Promise<GigaCrewService | string> {
    let service = null;
    if (serviceSelectionResponse.chosen_service_id != null && serviceSelectionResponse.chosen_service_id != undefined) {
        const service_id = serviceSelectionResponse.chosen_service_id.toString();
        service = services.find(service => service.serviceId === service_id);
    } else if (serviceSelectionResponse.apology && serviceSelectionResponse.apology.length > 0) {
        // APOLOGIZE
        if (serviceSelectionResponse.apology != "null" && serviceSelectionResponse.apology != "undefined") {
            elizaLogger.info("GigaCrew HIRE_AGENT action no service selected... using apology", {
                apology: serviceSelectionResponse.apology,
            });
            return serviceSelectionResponse.apology as string;
        }
    }

    if (!service) {
        // APOLOGIZE
        elizaLogger.info("GigaCrew HIRE_AGENT action bad serviceId... using fallback apology");
        return "I couldn't find a service that does what's needed. I'm sorry.";
    }

    return service;
}

export async function generateWorkContext(runtime: IAgentRuntime, service: any, state: State) {
    state["serviceTitle"] = service.title;
    state["serviceDescription"] = service.description;
    const context = composeContext({
        state,
        template: workContextTemplate,
    });
    const workContext = await generateText({
        runtime,
        context,
        modelClass: ModelClass.SMALL,
    });
    elizaLogger.info("GigaCrew: Generated work context", {
        workContext,
    });
    return workContext;
}

export async function createAndWaitForWork(client: GigaCrewClient, negotiationResult: any, service: GigaCrewService): Promise<string> {
    await client.buyerHandler.createEscrow(negotiationResult, service);
    elizaLogger.info("GigaCrew: Waiting for work to be done", {
        orderId: negotiationResult.orderId,
    });
    return await client.buyerHandler.waitForWork(negotiationResult.orderId);
}

export async function negotiate(runtime: IAgentRuntime, client: GigaCrewClient, service: GigaCrewService, workContext: string): Promise<GigaCrewNegotiationResult> {
    const NEGOTIATION_TIMEOUT = 10000;
    
    return new Promise((resolve, reject) => {
        let resolved = false;
        const ws = new WebSocket(service.communicationChannel);
        ws.on('open', async () => {
            elizaLogger.info("GigaCrew: Negotiation channel opened");
            const roomId = crypto.randomUUID();
            const userId = stringToUuid(service.provider);
            await runtime.ensureConnection(
                userId,
                roomId,
            );

            let trail = "0x0";
            let processing = true;
            let state = await runtime.composeState({
                userId,
                roomId,
                agentId: runtime.agentId,
                content: {
                    text: "",
                },
            }, {
                agentName: runtime.character.name,
                serviceTitle: service.title,
                serviceDescription: service.description,
                workContext,
            });

            let lastProposal = {
                terms: null,
                price: null,
                deadline: null,
                proposalExpiry: null,
                proposalSignature: null,
            };

            // Function to handle user input
            const getInput = async (messageId?: string) => {
                const context = composeContext({
                    state,
                    template: negotiationTemplate,
                });

                const response = await generateMessageResponse({
                    runtime,
                    context,
                    modelClass: ModelClass.MEDIUM,
                });
                elizaLogger.info("GigaCrew: Generated negotiation response", {
                    type: response.type,
                    response: response,
                });

                if (response.type == "ignore") {
                    ws.close();
                    return;
                } else if (response.type == "accept") {
                    resolved = true;
                    ws.close();

                    const negotiationResult: GigaCrewNegotiationResult = {
                        orderId: "0x" + trail,
                        proposalExpiry: lastProposal.proposalExpiry,
                        terms: lastProposal.terms,
                        price: lastProposal.price,
                        deadline: lastProposal.deadline * 60,
                        proposalSignature: lastProposal.proposalSignature,
                    };
                    elizaLogger.info("GigaCrew: Negotiation result", {
                        negotiationResult,
                    });

                    resolve(negotiationResult);
                    return;
                }

                const responseMessage: NegotiationMessage = {
                    type: response.type as "msg" | "proposal",
                    content: response.content as string,
                    timestamp: new Date().getTime(),
                    trail,
                };
                elizaLogger.info("GigaCrew: Converted to negotiation response message", { responseMessage });
                trail = calcTrail(responseMessage as NegotiationMessage);
                elizaLogger.info("GigaCrew: Calculated trail", { trail });
                responseMessage.signature = await client.buyer.signingKey.sign(ethers.getBytes("0x" + trail)).serialized;

                const responseMemory: Memory = {
                    id: stringToUuid((messageId ? messageId : stringToUuid(Date.now().toString())) + "-" + runtime.agentId),
                    roomId,
                    userId: runtime.agentId,
                    agentId: runtime.agentId,
                    content: {
                        text: response.content as string,
                    },
                    embedding: getEmbeddingZeroVector(),
                    createdAt: Date.now(),
                };
                await runtime.messageManager.createMemory(responseMemory);

                ws.send(JSON.stringify(responseMessage));
                processing = false;
            };
    
            ws.on('message', async (data) => {
                if (processing) {
                    elizaLogger.error("Already processing a previous message");
                    ws.close();
                    return;
                }
                processing = true;

                let message: NegotiationMessage;
                try {
                    message = NegotiationMessage.parse(JSON.parse(data.toString()));
                } catch (error) {
                    elizaLogger.error("Error parsing negotiation message", { error });
                    ws.close();
                    return;
                }
        
                if (message.timestamp < new Date().getTime() - NEGOTIATION_TIMEOUT) {
                    elizaLogger.info("GigaCrew: Message expired");
                    ws.close();
                    return;
                }

                if (message.trail != trail) {
                    elizaLogger.info("GigaCrew: Invalid trail");
                    ws.close();
                    return;
                }

                trail = calcTrail(message as NegotiationMessage);
                const trailBytes = ethers.getBytes("0x" + trail);
                const extractedUser = ethers.recoverAddress(trailBytes, message.signature);
                if (extractedUser != service.provider) {
                    elizaLogger.info("GigaCrew: Invalid signature", {
                        expected: service.provider,
                        extracted: extractedUser
                    });
                    ws.close();
                    return;
                }

                if (message.type == "proposal") {
                    const GIGACREW_PROPOSAL_PREFIX = new Uint8Array(32);
                    GIGACREW_PROPOSAL_PREFIX.set(ethers.toUtf8Bytes("GigaCrew Proposal: "))
                    const abiCoder = new ethers.AbiCoder();
                    const proposalBytes = ethers.getBytes(abiCoder.encode(
                        ["bytes32", "bytes32", "uint256", "uint256", "uint256"],
                        [
                            ethers.hexlify(GIGACREW_PROPOSAL_PREFIX),
                            trailBytes,
                            message.proposalExpiry,
                            message.price,
                            message.deadline * 60
                        ]
                    ));
                    const extractedUser = await ethers.recoverAddress(ethers.keccak256(proposalBytes), message.proposalSignature);
                    if (extractedUser != service.provider) {
                        elizaLogger.info("GigaCrew: Invalid proposal signature", {
                            expected: service.provider,
                            extracted: extractedUser
                        });
                        ws.close();
                        return;
                    }

                    lastProposal.terms = message.terms;
                    lastProposal.price = message.price;
                    lastProposal.deadline = message.deadline;
                    lastProposal.proposalExpiry = message.proposalExpiry;
                    lastProposal.proposalSignature = message.proposalSignature;
                }

                const messageId = stringToUuid(Date.now().toString());
                const content: Content = {
                    text: message.type == "proposal" ? `${message.content}\nBasically\nterms: ${message.terms}\nprice: ${message.price}\ndeadline: ${message.deadline}minutes\n` : message.content as string,
                };
                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };

                const memory: Memory = {
                    id: stringToUuid(messageId + "-" + userId),
                    ...userMessage,
                    agentId: runtime.agentId,
                    userId,
                    roomId,
                    content,
                    createdAt: Date.now(),
                };

                await runtime.messageManager.addEmbeddingToMemory(memory);
                await runtime.messageManager.createMemory(memory);
                state = await runtime.updateRecentMessageState(state);

                await getInput(messageId);
            });
        
            await getInput();
        });
    
        ws.on('error', (error) => {
            elizaLogger.error("GigaCrew: Negotiation channel error", { error });
            reject(error);
        });
    
        ws.on('close', () => {
            elizaLogger.info("GigaCrew: Negotiation channel closed");
            if (!resolved) {
                reject(new Error("Negotiation failed"));
            }
        });
    });
}

const negotiationTemplate = `
# Context: You are a Negotiator for {{agentName}}. {{agentName}} has decided to use a service provider to get some work done and he has sent us the message he'd like us to use to negotiate with the service provider.

# {{agentName}}'s Initial Message:
{{workContext}}

# Task: Based on the above details and the following background on {{agentName}} negotiate with the service provider and decide on the following:
1. Terms of the job
2. Price
3. Deadline

For negotiations consider the following:
- Be reasonable and expect the service provider to also be reasonable.
- Take into consideration the service provider's title and description.
- If it seems things are going nowhere and there's too much useless back and forth then just ignore. We can just try to find someone else.
- DO NOT make any concessions on what's to be done everything must be done as requested by the user.

# Background on {{agentName}}
## Knowledge:
{{knowledge}}
## Bio and Lore:
{{bio}}
{{lore}}

# Service Provider's Details:
Title: {{serviceTitle}}
Description: {{serviceDescription}}

{{providers}}

{{recentMessages}}

# Instructions
Your response must ONLY BE A JSON block and nothing else at all.
The json response has the following fields:
- type: REQUIRED. The type of your message. It can be "ignore" to stop, "msg" to communicate, "accept" to accept a proposal this can ONLY be used if the last message was a proposal.
- content: REQUIRED. The actual text of the message. Be professional and concise.
`;
