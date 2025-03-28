import { IAgentRuntime } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import { GigaCrewDatabase } from "./db";
import { ethers, EventLog } from "ethers";
import { GigaCrewConfig } from "./environment";
import { Log } from "ethers";
import { ProcessWorkFunction } from "./client";
import { GigaCrewService, GigaCrewNegotiationResult } from "./types";

export class GigaCrewBuyerHandler {
    runtime: IAgentRuntime;
    contract: ethers.Contract;
    provider: ethers.Provider;
    buyer: ethers.Wallet;
    serviceId: string;
    config: GigaCrewConfig;
    db: GigaCrewDatabase;
    orders: any;
    processWork: ProcessWorkFunction | null;

    constructor(runtime: IAgentRuntime, buyer: ethers.Wallet, contract: ethers.Contract, config: GigaCrewConfig, db: GigaCrewDatabase, processWork?: ProcessWorkFunction) {
        this.runtime = runtime;
        this.contract = contract.connect(buyer) as ethers.Contract;
        this.buyer = buyer;
        this.provider = contract.runner.provider;
        this.serviceId = config.GIGACREW_SERVICE_ID;
        this.config = config;
        this.db = db;
        this.orders = {};
        this.processWork = processWork;
    }

    async filters() {
        return [
            {
                event: await this.contract.filters.PoWSubmitted(null, this.buyer.address, null, null, null).getTopicFilter(),
                handler: this.PoWHandler.bind(this)
            }
        ];
    }

    start() {
        this.handleWithdrawals();
    }

    async PoWHandler(event: EventLog | Log) {
        const [orderId, buyer, seller, work, lockPeriod] = (event as EventLog).args;
        elizaLogger.info("Work Received!", {
            orderId,
            work
        });

        const order = await this.db.setWorkAndReturn(orderId, work, lockPeriod);
        await this.handleWork(order);
    }

    async createEscrow(negotiationResult: GigaCrewNegotiationResult, service: GigaCrewService, callbackData?: string) {
        const tx = await (await this.contract.createEscrow(negotiationResult.orderId, service.provider, negotiationResult.deadline.toString(), negotiationResult.proposalExpiry.toString(), negotiationResult.proposalSignature, { value: negotiationResult.price })).wait();
        const deadline = tx.logs[0].args[4].toString();
        await this.db.insertOrder(
            negotiationResult.orderId,
            this.serviceId,
            this.buyer.address,
            service.provider,
            "0",
            negotiationResult.terms,
            negotiationResult.price,
            deadline.toString(),
            callbackData
        );
    }

    async dispute(orderId: string) {
        try {
            const tx = await (await this.contract.submitDispute(orderId)).wait();
            const resolutionPeriod = tx.logs[0].args[1].toString();
            await this.db.setResolutionPeriod(orderId, resolutionPeriod);

            elizaLogger.info("Dispute created!", {
                orderId,
                tx
            });
        } catch (error) {
            elizaLogger.error("Error submitting dispute", {
                orderId,
                error
            });
        }
    }
    
    async waitForWork(orderId: string, timeout?: number): Promise<string> {
        // check DB for work first
        const order = await this.db.getOrder(orderId);
        if (order && order.work !== null) {
            return order.work;
        }

        return new Promise((resolve, reject) => {
            this.orders[orderId] = resolve;
            if (timeout) {
                setTimeout(() => {
                    delete this.orders[orderId];
                    reject(new Error("Timeout waiting for work"));
                }, timeout);
            }
        });
    }

    async handleWork(workRequest: any) {
        const resolve = this.orders[workRequest?.order_id];
        if (resolve) {
            delete this.orders[workRequest.order_id];
            resolve(workRequest.work);
        }

        if(this.processWork) {
            this.processWork(workRequest);
        }
    }

    async handleWithdrawals() {
        const withdrawals = await this.db.getWithdrawableOrdersForBuyer(this.buyer.address);
        const cantWithdrawIds = [];

        for (const withdrawal of withdrawals) {
            const { order_id: orderId } = withdrawal;
            try {
                // Make sure buyer can withdraw funds by checking for dispute / dispute result
                try {
                    const buyerShare = await this.contract.disputeResult(orderId);
                    if (buyerShare == 0) {
                        // Fully resolved in favor of seller
                        cantWithdrawIds.push(orderId);
                        continue;
                    }
                } catch (error) {
                    if (error.revert?.name == "DisputeResolutionPeriodNotPassed") {
                        // Dispute resolution period not passed
                        await this.db.setResolutionPeriod(orderId, error.revert.args[0].toString());
                        continue;
                    }
                    // Else = No dispute found
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

        await this.db.setCanBuyerWithdraw(cantWithdrawIds, false);
        setTimeout(() => {
            this.handleWithdrawals();
        }, 2000);
    }
}
