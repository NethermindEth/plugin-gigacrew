import { composeContext, Content, generateMessageResponse, getEmbeddingZeroVector, IAgentRuntime, Memory, ModelClass, State, stringToUuid, UUID } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import { GigaCrewDatabase } from "./db";
import { ethers, EventLog, Log } from "ethers";
import { GigaCrewConfig } from "./environment";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import { calcTrail, NegotiationMessage } from "./negotiation";
import { WorkFunction } from "./client";

export class GigaCrewSellerHandler {
    runtime: IAgentRuntime;
    contract: ethers.Contract;
    provider: ethers.Provider;
    seller: ethers.Wallet;
    serviceId: string;
    config: GigaCrewConfig;
    db: GigaCrewDatabase;
    totalTime: number;
    work: WorkFunction;
    service: any;

    constructor(runtime: IAgentRuntime, seller: ethers.Wallet, contract: ethers.Contract, config: GigaCrewConfig, db: GigaCrewDatabase, work: WorkFunction) {
        this.runtime = runtime;
        this.contract = contract.connect(seller) as ethers.Contract;
        this.seller = seller;
        this.provider = contract.runner.provider;
        this.serviceId = config.GIGACREW_SERVICE_ID;
        this.totalTime = config.GIGACREW_TIME_PER_SERVICE + config.GIGACREW_TIME_BUFFER;
        this.config = config;
        this.work = work;
        this.db = db;
    }

    async filters() {
        return [
            {
                event: await this.contract.filters.EscrowCreated(null, this.serviceId, null, this.seller.address, null, null).getTopicFilter(),
                handler: this.EscrowCreatedHandler.bind(this)
            }
        ];
    }

    isExpired(deadline: any) {
        const start = new Date();
        const end = new Date(parseInt(deadline) * 1000 - this.totalTime * 1000);
        return start > end;
    }

    EscrowCreatedHandler(event: EventLog | Log) {
        const [orderId, serviceId, buyer, seller, context, deadline] = (event as EventLog).args;
        this.saveNewOrder(orderId, serviceId, buyer, seller, context, deadline);
    }

    saveNewOrder(orderId: string, serviceId: string, buyer: string, seller: string, context: string, deadline: string) {
        if (this.isExpired(deadline)) {
            elizaLogger.info("Can't handle this order! Skipping", {
                orderId,
                serviceId,
                buyer,
                seller,
                context,
                deadline
            });
            return;
        }
        elizaLogger.info("Order Received! Saving to DB", {
            orderId,
            serviceId,
            buyer,
            seller,
            context,
            deadline
        });
        this.db.insertOrder(orderId.toString(), serviceId.toString(), buyer, seller, "0", context, deadline.toString());
    }

    async start() {
        const [paused, seller, title, description, communicationChannel, price] = await this.contract.services(this.serviceId);
        this.service = {
            title,
            description,
            price: "$" + price
        }

        this.handleOrders();    
        this.handleWithdrawals();

        this.startNegotiator();
    }

    async handleOrders() {
        const orders = await this.db.getActiveOrdersForSeller(this.seller.address);
        for (const order of orders) {
            const { order_id: orderId, service_id: serviceId, buyer_address: buyer, seller_address: seller, context, deadline } = order;
            const deadlineTimestamp = new Date(deadline + 'Z').getTime() / 1000;
            if (this.isExpired(deadlineTimestamp)) {
                elizaLogger.info("Order is expired, skipping", { orderId, serviceId, buyer, seller, context, deadline });
                continue;
            }

            let response = (await this.db.getOrder(orderId))?.work;
            if (!response) {
                try {
                    response = await this.work(this.runtime, orderId, buyer, context);
                    await this.db.setWork(orderId, response);
                } catch (error) {
                    await this.db.incrementFailedAttempts(orderId);
                    elizaLogger.error("Error doing work", {
                        orderId,
                        error
                    });
                    continue;
                }
            }
            
            try {
                const tx = await (await this.contract.submitPoW(orderId, response)).wait();

                elizaLogger.info("Work Submitted!", {
                    orderId,
                    response,
                    tx
                });

                const lockPeriod = tx.logs[0].args[4].toString();
                await this.db.setLockPeriod(orderId, lockPeriod);
            } catch (error) {
                elizaLogger.error("Error submitting work", {
                    orderId,
                    error
                });
            }
        }
        setTimeout(() => {
            this.handleOrders();
        }, 2000);
    }

    async handleWithdrawals() {
        const withdrawals = await this.db.getWithdrawableOrdersForSeller(this.seller.address);
        const cantWithdrawIds = [];

        for (const withdrawal of withdrawals) {
            const { order_id: orderId } = withdrawal;
            try {
                // Make sure seller can withdraw funds by checking for dispute / dispute result
                try {
                    const buyerShare = await this.contract.disputeResult(orderId);
                    if (buyerShare == 100) {
                        // Fully resolved in favor of buyer
                        cantWithdrawIds.push(orderId);
                        continue;
                    }
                } catch (error) {
                    if (error.revert?.name == "DisputeResolutionPeriodNotPassed") {
                        // Dispute resolution period not passed
                        await this.db.setResolutionPeriod(orderId, error.revert.args[0].toString());
                        continue;
                    }
                    // No dispute found
                }

                const tx = await (await this.contract.withdrawFunds(orderId, "0x")).wait();

                elizaLogger.info("Withdrawal successful!", {
                    orderId,
                    tx
                });

                cantWithdrawIds.push(orderId);
            } catch (error) {
                elizaLogger.error("Error withdrawing funds", {
                    orderId,
                    error
                });

                if (error.action == "estimateGas" && error.data?.startsWith("0x32c6b2c3")) {
                    const resolutionPeriod = ethers.toBigInt("0x" + error.data.slice(10)).toString();
                    await this.db.setResolutionPeriod(orderId, resolutionPeriod);
                }
            }
        }

        await this.db.setCanSellerWithdraw(cantWithdrawIds, false);
        setTimeout(() => {
            this.handleWithdrawals();
        }, 2000);
    }

    async startNegotiator() {
        const server = new WebSocketServer({ port: 8005 });

        server.on('connection', async (socket) => {
            // Any new socket is a new room
            const roomId = crypto.randomUUID();
            let userId: UUID | undefined;
            let key: string | undefined;
            let trail = "0x0";

            let state: State | null;

            let processing = false;

            socket.on('message', async (message) => {
                if (processing) {
                    elizaLogger.error("Already processing a previous message", { message });
                    socket.close();
                    return;
                }
                processing = true;

                let data: NegotiationMessage;
                try {
                    data = NegotiationMessage.parse(JSON.parse(message.toString()));
                } catch (error) {
                    elizaLogger.error("Error parsing negotiation message", { error });
                    socket.close();
                    return;
                }

                if (data.type != "msg") {
                    elizaLogger.error("Invalid message type", { data });
                    socket.close();
                    return;
                }

                if (data.timestamp < new Date().getTime() - 5000) {
                    elizaLogger.error("Message expired", { data });
                    socket.close();
                    return;
                }

                if (trail != data.trail) {
                    elizaLogger.error("Trail mismatch", { trail, data });
                    socket.close();
                    return;
                }

                if (!userId) { // It's the first message
                    userId = stringToUuid(data.signature);
                    key = data.key;
                    await this.runtime.ensureConnection(
                        userId,
                        roomId,
                    );

                    state = await this.runtime.composeState({
                        userId,
                        roomId,
                        agentId: this.runtime.agentId,
                        content: {
                            text: "",
                        },
                    }, {
                        agentName: this.runtime.character.name,
                        serviceTitle: this.service.title,
                        serviceDescription: this.service.description,
                        servicePrice: "$" + this.service.price,
                    });
                }
                
                const messageId = stringToUuid(Date.now().toString());
                const content: Content = {
                    text: data.content,
                };
                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: this.runtime.agentId,
                };
            
                const memory: Memory = {
                    id: stringToUuid(messageId + "-" + userId),
                    ...userMessage,
                    createdAt: Date.now(),
                };

                await this.runtime.messageManager.addEmbeddingToMemory(memory);
                await this.runtime.messageManager.createMemory(memory);
                state = await this.runtime.updateRecentMessageState(state);

                const context = composeContext({
                    state,
                    template: negotiationTemplate,
                });

                const response = await generateMessageResponse({
                    runtime: this.runtime,
                    context,
                    modelClass: ModelClass.MEDIUM,
                });
                elizaLogger.info("GigaCrew: Generated negotiation response", {
                    type: response.type,
                    content: response.content,
                });

                if (response.type == "ignore") {
                    elizaLogger.info("Ignoring message", { response });
                    socket.close();
                    return;
                }

                const responseMessage = {
                    type: response.type,
                    content: response.content,
                    timestamp: new Date().getTime(),
                    signature: this.seller.address,
                    trail: calcTrail(data),
                };
                
                trail = calcTrail(responseMessage as NegotiationMessage);

                const responseMemory: Memory = {
                    id: stringToUuid(messageId + "-" + this.runtime.agentId),
                    ...userMessage,
                    userId: this.runtime.agentId,
                    content: {
                        text: response.content as string,
                    },
                    embedding: getEmbeddingZeroVector(),
                    createdAt: Date.now(),
                };
                await this.runtime.messageManager.createMemory(responseMemory);
                state = await this.runtime.updateRecentMessageState(state);

                socket.send(JSON.stringify(responseMessage));
                processing = false;
            });

            socket.on('error', (error) => {
                elizaLogger.error("Negotiation channel error", { error });
            });
        });
    }
}

const negotiationTemplate = `
# Task: You are a negotiator who works for {{agentName}} your task is to negotiate with this person you're having a conversation with who would like to buy {{agentName}}'s service (For now all services are one-off i.e. one task that's done and result is given to the buyer).
Keep your responses short and concise don't repeat yourself too much.

The Service Being Provided:
Title: {{serviceTitle}}
Description: {{serviceDescription}}
Absolute Minimum Price: {{servicePrice}}

# Background on {{agentName}}
## His Knowledge:
{{knowledge}}

## What he was told when he was created
{{bio}}
{{lore}}

{{providers}}

{{recentMessages}}

# Rough idea of how to negotiate
{user1}: Hey I need A
{you}: Ok A is possible. How much are you willing to pay for it? How long are you willing to wait?
{user1}: I'm willing to pay 100 dollars and I need it in 3 days
{you}: "Proposal" Sounds reasonable. Here's our terms 1. A 2. 120 dollars 3. 4 days from today.
{user1}: Actually can you do it in 2 days?
{you}: "Proposal" Yes but will cost more. 1. A 2. 150 dollars 3. 2 days from today.
{user1}: Ok!

# Instructions
Respond to the buyer's request and message considering the following:
1. Do we have all the required information and data needed for {{ agentName }} to start working on the order? If not let's ask and make sure we know everything surrounding the user's requirements. If the buyer seems unable to provide all the information you need then just "ignore" and end the conversation.
2. If the buyer's request is not acceptable (doesn't match what {{ agentName }} can do or isn't clear) or seems just random and unrelated to the service then just "ignore" and end the conversation.
3. You and the buyer need to agree on 3 things. The terms (what to be done), the price and the deadline (use minutes for the deadline).
4. If it seems the buyer and you can't reach an agreement on terms, or price, or deadline after 3-4 back n forths on different proposals then just "ignore" and end the conversation.
5. NEVER USE DECIMALS FOR PRICE. IT MUST ALWAYS BE A WHOLE NUMBER.
6. NEVER AGREE TO A DEADLINE BELOW 2 MINUTES

Your response must be JSON with following fields:
1. type
    - If ignoring "ignore"
    - If just communicating normally as part of negotiations and your message isn't something that can be agreed to for starting the work "msg"
    - If you have all you need (what to be done) and no clarification is required and you just want the buyer to either say ok or not ok and counter your proposal "proposal".
2. content: the actual text of the message. If type is going to be a "proposal" then your message MUST clearly outline the terms (full context of what exactly is to be done with precise information), price and deadline (in minutes) like a small contract.
`;
