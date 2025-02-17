import { Plugin } from "@elizaos/core";
import { GigaCrew } from "./client";
import { GigaCrewHireAction } from "./actions";

const gigaCrewPlugin = {
    name: "GigaCrew",
    description: "GigaCrew plugin",
    clients: [new GigaCrew()],
    actions: [GigaCrewHireAction],
} as Plugin;

export default gigaCrewPlugin;
