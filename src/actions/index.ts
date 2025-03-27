import { GigaCrewClient } from "../client";
import { Content, generateMessageResponse, getEmbeddingZeroVector, ModelClass, stringToUuid, UUID } from "@elizaos/core";
import { composeContext, elizaLogger, generateText, HandlerCallback } from "@elizaos/core";
import { Action, IAgentRuntime, Memory, State } from "@elizaos/core";
import { calcTrail, NegotiationMessage, validateMessage } from "gigacrew-negotiation";
import { WebSocket } from "ws";
import { GigaCrewNegotiationResult, GigaCrewService } from "../types.ts";
import { ethers } from "ethers";

import { GigaCrewListServicesAction } from "./list_services.ts";
import { GigaCrewHireAction } from "./hire.ts";
export { GigaCrewListServicesAction, GigaCrewHireAction };

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

# Instructions: The query should be less than 100 words and explain the type of service that you need in the form of a search query rather than a message to someone. Your response MUST ONLY contain the query.
`;

export const selectManyServicesTemplate = `
You used this query to search for some services: {{serviceQuery}}
Now the results are in and you can see them below.

# ServiceList:
{{serviceList}}

# Task: Now you need to either 1. Pick ALL the services in the list that seem appropriate based on the query 2. Decide that you want to search again with a different query because NONE of the services seem useful for it 3. Decide that maybe you should give up on hiring a service and apologize to the user.
So you're basically being used to filter out the services that are irrelevant.

About {{agentName}}:
{{bio}}
{{lore}}
{{knowledge}}

{{providers}}

{{messageDirections}}

{{recentMessages}}

# Instructions
Your response must be formatted in a JSON block.
The possible fields are "chosen_service_ids", "new_query" and "apology".
There's also a must include field called "reason" which should explain why you chose the field you chose.
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

export async function searchServices(runtime: IAgentRuntime, query: string): Promise<GigaCrewService[]> {
    const endpoint = (runtime.getSetting("GIGACREW_INDEXER_URL") || process.env.GIGACREW_INDEXER_URL) + "/api/services/search";
    const response = await fetch(`${endpoint}?query=${encodeURIComponent(query)}&limit=10`);
    const data = await response.json();
    return data;
}

export async function searchAndSelectService(runtime: IAgentRuntime, query: string, state: State, many: boolean = false): Promise<{ services: GigaCrewService[], serviceSelectionResponse: any }> {
    let services = null;
    let serviceSelectionResponse = null;
    let retries = 0;
    do {
        services = await searchServices(runtime, query);
        elizaLogger.info("GigaCrew HIRE_AGENT action searched for services", {
            services,
        });

        // Decide which service to hire if any
        state["serviceQuery"] = query;
        state["serviceList"] = !Array.isArray(services) || services.length == 0 ? "NO SERVICES FOUND" : services.map(service => `ID: ${service.serviceId} - Title: ${service.title.replace(/\\n/g, " ")} - Description: ${service.description.replace(/\\n/g, " ")}`).join("\n");
        const serviceContext = composeContext({
            state,
            template: many ? selectManyServicesTemplate : selectServiceTemplate,
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

export async function handleServiceSelection(serviceSelectionResponse: any, services: GigaCrewService[], many: boolean = false): Promise<GigaCrewService | GigaCrewService[] | string> {
    const field_name = many ? "chosen_service_ids" : "chosen_service_id";
    
    let service = null;
    if (serviceSelectionResponse[field_name] != null && serviceSelectionResponse[field_name] != undefined) {
        const service_ids = many ? serviceSelectionResponse[field_name].map(id => id.toString()) : [serviceSelectionResponse[field_name].toString()];
        service = services.filter(service => service_ids.includes(service.serviceId));
    } else if (serviceSelectionResponse.apology && serviceSelectionResponse.apology.length > 0) {
        // APOLOGIZE
        if (serviceSelectionResponse.apology != "null" && serviceSelectionResponse.apology != "undefined") {
            elizaLogger.info("GigaCrew no service selected... using apology", {
                apology: serviceSelectionResponse.apology,
            });
            return serviceSelectionResponse.apology as string;
        }
    }

    if (!service) {
        // APOLOGIZE
        elizaLogger.info("GigaCrew bad serviceId... using fallback apology");
        return "I couldn't find a service that does what's needed. I'm sorry.";
    }

    return many ? service : service[0];
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
                // responseMessage.signature = await client.buyer.signingKey.sign(ethers.getBytes("0x" + trail)).serialized;

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

                const validateMessageResult = validateMessage(data.toString(), trail, service.provider);
                let message = validateMessageResult.message;
                trail = validateMessageResult.trail;
                if (!message) {
                    elizaLogger.error("Invalid message", { message: data.toString() });
                    ws.close();
                    return;
                }

                // const extractedUser = ethers.recoverAddress(trailBytes, message.signature);
                // if (extractedUser != service.provider) {
                //     elizaLogger.info("GigaCrew: Invalid signature", {
                //         expected: service.provider,
                //         extracted: extractedUser
                //     });
                //     ws.close();
                //     return;
                // }

                if (message.type == "proposal") {
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
