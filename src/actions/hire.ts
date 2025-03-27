import { Action, elizaLogger, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { createAndWaitForWork, generateServiceQuery, generateWorkContext, handleServiceSelection, negotiate, searchAndSelectService } from ".";
import { GigaCrewClient } from "../client";
import { GigaCrewService } from "../types";

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
        const { services, serviceSelectionResponse } = await searchAndSelectService(runtime, query, state);

        // Handle service selection
        const service = await handleServiceSelection(serviceSelectionResponse, services) as GigaCrewService;
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
