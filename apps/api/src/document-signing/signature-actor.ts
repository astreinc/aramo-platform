import { rawAccessToken } from '@aramo/auth';
import { signatureActor, type SignatureActor } from '@aramo/documents-contracts';
import type { Request } from 'express';

// Addendum S6 ruling 2 — the typed actor credential of a user-initiated signing
// action: the request's own (already verified) Aramo access token, wrapped so it
// is never serialized or logged. Undefined when the request carries no token.
export function signatureActorFrom(req: Request): SignatureActor | undefined {
  const token = rawAccessToken(req as Request & { cookies?: Record<string, string> });
  return token === null ? undefined : signatureActor(token);
}
