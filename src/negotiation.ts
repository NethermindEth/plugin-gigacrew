import { z } from "zod";
import crypto from "crypto";

const NegotiationMessage = z.object({
    type: z.enum(["msg", "proposal"]),
    content: z.string(),
    timestamp: z.number(),
    trail: z.string(),

    price: z.string().regex(/^\d+$/).optional(),
    deadline: z.number().optional(),
    terms: z.string().optional(),
    proposalExpiry: z.number().optional(),

    signature: z.string(),    
    proposalSignature: z.string().optional(),

    key: z.string().optional(),
});
type NegotiationMessage = z.infer<typeof NegotiationMessage>;
function calcTrail(message: NegotiationMessage) {
    let hash = message.trail;
    for (const key of Object.keys(message).sort()) {
        if (key == "trail" || key == "signature" || key == "proposalSignature") continue;
        const value = message[key as keyof NegotiationMessage];
        const valueHash = crypto.createHash('sha256').update(value?.toString() as any).digest('hex');
        hash = crypto.createHash('sha256').update(hash + valueHash).digest('hex');
    }
    return hash;
}

export { NegotiationMessage, calcTrail };
