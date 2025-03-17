import { z } from "zod";
import crypto from "crypto";

const NegotiationMessage = z.object({
    type: z.enum(["msg", "proposal"]),
    content: z.string(),
    key: z.string().optional(),
    expire: z.number().optional(),
    timestamp: z.number(),
    signature: z.string(),
    trail: z.string()
});
type NegotiationMessage = z.infer<typeof NegotiationMessage>;
function calcTrail(message: NegotiationMessage) {
    let hash = message.trail;
    for (const key of Object.keys(message).sort()) {
        if (key == "trail") continue;
        const value = message[key as keyof NegotiationMessage];
        const valueHash = crypto.createHash('sha256').update(value?.toString() as any).digest('hex');
        hash = crypto.createHash('sha256').update(hash + valueHash).digest('hex');
    }
    return hash;
}

export { NegotiationMessage, calcTrail };
