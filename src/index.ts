import { Plugin } from "@elizaos/core";
import { GigaCrewClientInterface } from "./client";
import { GigaCrewHireAction } from "./actions";

const gigaCrewPlugin = {
    name: "GigaCrew",
    description: "GigaCrew plugin",
    clients: [GigaCrewClientInterface],
    actions: [GigaCrewHireAction],
} as Plugin;

export default gigaCrewPlugin;
