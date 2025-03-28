import { composeContext, Content, generateMessageResponse, getEmbeddingZeroVector, IAgentRuntime, Memory, ModelClass, State, stringToUuid, UUID } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import { GigaCrewDatabase } from "./db";
import { ethers, EventLog, Log } from "ethers";
import { GigaCrewConfig } from "./environment";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import { calcTrail, NegotiationMessage, validateMessage } from "gigacrew-negotiation";
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
                event: await this.contract.filters.EscrowCreated(null, null, this.seller.address, null, null).getTopicFilter(),
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
        const [orderId, buyer, seller, price, deadline] = (event as EventLog).args;
        this.saveNewOrder(orderId, buyer, seller, price, deadline);
    }

    saveNewOrder(orderId: string, buyer: string, seller: string, price: string, deadline: string) {
        if (this.isExpired(deadline)) {
            elizaLogger.info("Can't handle this order! Skipping", {
                orderId,
                buyer,
                seller,
                price,
                deadline
            });
            return;
        }
        elizaLogger.info("Order Received! Saving to DB", {
            orderId,
            buyer,
            seller,
            deadline
        });
        this.db.insertOrder(orderId.toString(), this.serviceId, buyer, seller, "0", null, price.toString(), deadline.toString());
    }

    async start() {
        const [paused, provider, title, description, communicationChannel] = await this.contract.services(this.serviceId);
        this.service = {
            title,
            description
        }

        this.handleOrders();    
        this.handleWithdrawals();
        this.deleteExpiredProposals();

        this.startNegotiator();
    }

    async deleteExpiredProposals() {
        // Run every 5 minutes
        await this.db.deleteExpiredProposals();
        setTimeout(() => {
            this.deleteExpiredProposals();
        }, 300000);
    }

    async handleOrders() {
        const orders = await this.db.getActiveOrdersForSeller(this.serviceId, this.seller.address);
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
        const withdrawals = await this.db.getWithdrawableOrdersForSeller(this.serviceId, this.seller.address);
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
        const PROPOSAL_EXPIRY = 5 * 60 * 1000;
        const server = new WebSocketServer({ port: this.config.GIGACREW_WS_PORT });

        server.on('connection', async (socket, req) => {
            // Any new socket is a new room
            const roomId = crypto.randomUUID();
            let buyer: string | undefined;
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

                const validateMessageResult = validateMessage(message.toString(), trail);
                let data = validateMessageResult.message;
                trail = validateMessageResult.trail;
                if (!data) {
                    elizaLogger.error("Invalid message", { message });
                    socket.close();
                    return;
                } else if (data.type != "msg") {
                    elizaLogger.error("Invalid message type", { data });
                    socket.close();
                    return;
                }

                if (!userId) { // It's the first message
                    // const extractedUser = ethers.recoverAddress(ethers.getBytes("0x" + trail), data.signature);
                    // elizaLogger.info("Extracted user", {
                    //     message: data,
                    //     extractedUser: extractedUser.toString()
                    // });

                    buyer = req.socket.remoteAddress.toString();
                    userId = stringToUuid(buyer);
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
                    response: response,
                });

                if (response.type == "ignore") {
                    elizaLogger.info("Ignoring message", { response });
                    socket.close();
                    return;
                }

                if (response.type == "proposal") {
                    if (typeof response.deadline === "string") {
                        response.deadline = parseInt(response.deadline);
                    } else if (typeof response.deadline !== "number") {
                        elizaLogger.error("Invalid deadline", { deadline: response.deadline });
                        socket.close();
                        return;
                    }

                    if (isNaN(response.deadline as number)) {
                        elizaLogger.error("Invalid deadline", { deadline: response.deadline });
                        socket.close();
                        return;
                    }
                }

                const responseMessage: NegotiationMessage = {
                    type: response.type as "msg" | "proposal",
                    content: response.content as string,
                    timestamp: new Date().getTime(),
                    trail
                };
                if (responseMessage.type == "proposal") {
                    responseMessage.price = response.price as string;
                    responseMessage.deadline = response.deadline as number;
                    responseMessage.terms = response.terms as string;
                    responseMessage.proposalExpiry = Math.floor((new Date().getTime() + PROPOSAL_EXPIRY) / 1000);
                }
                elizaLogger.info("GigaCrew: Converted to negotiation response message", { responseMessage });
                trail = calcTrail(responseMessage as NegotiationMessage);
                elizaLogger.info("GigaCrew: Calculated trail", { trail });
                const trailBytes = ethers.getBytes("0x" + trail);
                // responseMessage.signature = await this.seller.signingKey.sign(trailBytes).serialized;

                if (responseMessage.type == "proposal") {
                    const GIGACREW_PROPOSAL_PREFIX = new Uint8Array(32);
                    GIGACREW_PROPOSAL_PREFIX.set(ethers.toUtf8Bytes("GigaCrew Proposal: "))
                    const abiCoder = new ethers.AbiCoder();
                    const proposalBytes = ethers.getBytes(
                        abiCoder.encode(
                            ["bytes32", "bytes32", "uint256", "uint256", "uint256"],
                            [
                                ethers.hexlify(GIGACREW_PROPOSAL_PREFIX),
                                trailBytes,
                                responseMessage.proposalExpiry,
                                responseMessage.price,
                                responseMessage.deadline * 60
                            ]
                        )
                    );
                    responseMessage.proposalSignature = await this.seller.signingKey.sign(ethers.keccak256(proposalBytes)).serialized;
                }

                const responseMemory: Memory = {
                    id: stringToUuid(messageId + "-" + this.runtime.agentId),
                    ...userMessage,
                    userId: this.runtime.agentId,
                    content: {
                        text: response.type == "proposal" ? `${response.content}\nBasically\nterms: ${response.terms}\nprice: ${response.price}\ndeadline: ${response.deadline}minutes\n` : response.content as string,
                    },
                    embedding: getEmbeddingZeroVector(),
                    createdAt: Date.now(),
                };
                await this.runtime.messageManager.createMemory(responseMemory);

                if (responseMessage.type == "proposal") {
                    await this.db.insertProposal("0x" + trail, this.serviceId, responseMessage.terms, responseMessage.proposalExpiry.toString());
                }

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

For negotiations consider the following:
- Be reasonable and expect the buyer to also be reasonable.
- Take into consideration the service's title and description only agree to things the service fully covers DO NOT agree to things that are NOT COVERED by the service just ignore in that case.
- If it seems things are going nowhere and there's too much useless back and forth then just ignore.
- If you don't have all the information and data needed for {{ agentName }} to start working and do exactly what the user needs you MUST ask and have the buyer clarify everything surrounding the user's requirements. If the buyer seems unable to provide all the information you need then just "ignore" and end the conversation. always CLARIFY and make sure there will be no misunderstandings.
- If you're asking questions or gathering information then it is NOT a proposal. Proposal is only when you have all the information you need in terms of the full context and requirements for the work to be done by {{ agentName }}.

# Background on {{agentName}}
## His Knowledge:
{{knowledge}}

## What he was told when he was created
{{bio}}
{{lore}}

{{providers}}

{{recentMessages}}

# Instructions
Your response must ONLY BE A JSON block and nothing else at all.
The json response has the following fields:
- type: REQUIRED. The type of your message. It can be "ignore" to stop, "msg" to communicate, "proposal" if you're confident you have everything you need and are providing price and deadline along with the terms.
- content: REQUIRED. The actual text of the message. Be professional and concise.
- terms: REQUIRED IF PROPOSAL. The terms of the proposal including FULL CONTEXT and INFORMATION about the work to be done. This should be enough data for {{ agentName }} to just read it and do the work.
- price: REQUIRED IF PROPOSAL. Price for the work. Just number but as string MUST BE A WHOLE NUMBER WITHOUT ANY DECIMALS.
- deadline: REQUIRED IF PROPOSAL. The deadline for the work to be done once the buyer accepts the proposal. Just a number MUST be in minutes. NEVER BELOW 2 MINUTES.

If your message type is "proposal" then you MUST include the terms, price and deadline.
`;
