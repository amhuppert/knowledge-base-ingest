import { z } from 'zod';
import {
  makeSourceId, makeChunkId, makeSpanId, makeNodeId, makeClaimId, makeEntityId,
  makeRelationshipId,
} from '../ids.js';

/** Build a Zod schema that validates a prefixed id string and brands it. */
function branded<T>(make: (raw: string) => T) {
  return z.string().transform((s, ctx): T => {
    try {
      return make(s);
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
      return z.NEVER;
    }
  });
}

export const zSourceId = branded(makeSourceId);
export const zChunkId = branded(makeChunkId);
export const zSpanId = branded(makeSpanId);
export const zNodeId = branded(makeNodeId);
export const zClaimId = branded(makeClaimId);
export const zEntityId = branded(makeEntityId);
export const zRelationshipId = branded(makeRelationshipId);
