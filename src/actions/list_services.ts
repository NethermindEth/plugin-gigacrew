import { Action, elizaLogger, getEmbeddingZeroVector, HandlerCallback, IAgentRuntime, Memory, State, stringToUuid } from "@elizaos/core";
import { generateServiceQuery, handleServiceSelection, searchAndSelectService, searchServices } from ".";
import { GigaCrewClient } from "../client";
import { GigaCrewService } from "../types";

export const GigaCrewListServicesAction: Action = {
    name: "LIST_SERVICES",
    similes: ["LIST_SERVICE", "LIST_AGENTS"],
    description: 
    "Use this action when you need to list services / agents that are available to be hired to do some task. And if a user wants to hire one of the services you can use the HAND_OFF_<provider_address> action",
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
                    text: "Here are the services that are available to be hired on GigaCrew that seem to be related to what you need help with.",
                    action: "LIST_SERVICES",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "ID: 2\nTitle: Calculator Service\nDescription: I do calculations for you\nProvider: 0x123\n\nID: 7\nTitle: Math tutor\nDescription: I can help you with maths\nProvider: 0x777",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "I want the first one",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Got it. You are now handed off to the service provider for negotiation. Please talk about what you need in details and negotiate with him directly.",
                    action: "HAND_OFF_0x123",
                },
            },
        ],
    ],
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        // Always allow looking up services
        return true;
    },
    handler: async (runtime: IAgentRuntime, message: Memory, state?: State, options?: { [key: string]: unknown }, callback?: HandlerCallback) => {
        elizaLogger.info("GigaCrew LIST_SERVICES action called", {
            message: message.content.text,
        });

        // Generate service query
        const query = await generateServiceQuery(runtime, state);

        // Search for services
        const { services, serviceSelectionResponse } = await searchAndSelectService(runtime, query, state, true);
        const chosen_services = await handleServiceSelection(serviceSelectionResponse, services, true) as GigaCrewService[];

        const serviceList = chosen_services.map(service => `ID: ${service.serviceId}\nTitle: ${service.title.replace(/\\n/g, " ")}\nDescription: ${service.description.replace(/\\n/g, " ")}\nProvider: ${service.provider}`).join("\n\n");
        const responseMessage: Memory = {
            id: stringToUuid(stringToUuid(Date.now().toString()) + "-" + runtime.agentId),
            userId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: message.roomId,
            content: {
                text: serviceList,
            },
            embedding: getEmbeddingZeroVector(),
            createdAt: Date.now(),
        };

        await runtime.messageManager.createMemory(responseMessage);

        callback({
            text: serviceList,
        });
    }
}
