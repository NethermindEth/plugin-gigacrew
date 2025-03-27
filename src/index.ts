import { Plugin } from "@elizaos/core";
import { GigaCrew } from "./client";
import { GigaCrewHireAction, GigaCrewListServicesAction } from "./actions";
import { NegotiationMessage, calcTrail } from "gigacrew-negotiation";

const gigaCrewPlugin = {
    name: "GigaCrew",
    description: "GigaCrew plugin",
    clients: [new GigaCrew()],
    actions: [GigaCrewHireAction],
} as Plugin;

export { GigaCrewListServicesAction, calcTrail, NegotiationMessage };
export default gigaCrewPlugin;
