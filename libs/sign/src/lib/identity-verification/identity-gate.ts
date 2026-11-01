import type { PrismaService } from '../prisma/prisma.service.js';

import { StripeIdentityAdapter } from './stripe-identity.adapter.js';
import { DisabledIdentityVerificationAdapter, type IdentityVerificationPort } from './identity-verification.port.js';

// Feature-Parity §1.9 — recipient verification methods the sender can set per recipient.
// (ACCESS_CODE and SMS_OTP, the other §1.9 methods, are separate features with their own columns.)
export const IDENTITY_VERIFICATION_METHODS = ['ID_VERIFICATION', 'KBA'] as const;
export type IdentityVerificationMethod = (typeof IDENTITY_VERIFICATION_METHODS)[number];

// Ledger event types (ordinary appended SignatureEvent rows; payloads carry no document data).
export const IDENTITY_VERIFICATION_STARTED_EVENT = 'IDENTITY_VERIFICATION_STARTED';
export const IDENTITY_VERIFIED_EVENT = 'IDENTITY_VERIFIED';
export const IDENTITY_VERIFICATION_FAILED_EVENT = 'IDENTITY_VERIFICATION_FAILED';
export const IDENTITY_VERIFICATION_CANCELLED_EVENT = 'IDENTITY_VERIFICATION_CANCELLED';
export const IDENTITY_VERIFICATION_LOCKED_EVENT = 'IDENTITY_VERIFICATION_LOCKED';

/** Verification attempts a recipient may start before they are locked out (SIGN_ID_VERIFICATION_MAX_ATTEMPTS). */
export const ID_VERIFICATION_MAX_ATTEMPTS_DEFAULT = 3;

export function idVerificationMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['SIGN_ID_VERIFICATION_MAX_ATTEMPTS'] ?? ID_VERIFICATION_MAX_ATTEMPTS_DEFAULT);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : ID_VERIFICATION_MAX_ATTEMPTS_DEFAULT;
}

/** The recipient must verify their identity before the envelope is shown (403). */
export class SignerIdentityVerificationRequiredError extends Error {
  constructor(
    readonly signerId: string,
    readonly method: IdentityVerificationMethod,
  ) {
    super('Verify your identity to open this document');
    this.name = 'SignerIdentityVerificationRequiredError';
  }
}

/** The recipient used every attempt, or the verified name did not match (423). */
export class SignerIdentityVerificationLockedError extends Error {
  constructor(
    readonly signerId: string,
    readonly reason: 'attempts_exhausted' | 'name_mismatch' | 'locked' = 'locked',
  ) {
    super('Identity verification did not succeed. The sender has been told.');
    this.name = 'SignerIdentityVerificationLockedError';
  }
}

type GateClient = Pick<PrismaService, 'signer' | 'signRecipientIdentityVerification'>;

/**
 * Feature-Parity §1.9 — enforced by the ENGINE on every signer action that shows or changes
 * the envelope (document view, source bytes, fill, complete): a recipient the sender asked
 * to verify must hold a VERIFIED attempt for that method; a locked recipient is refused.
 * A recipient without a verification method passes. Verification is per recipient, so a
 * reminder's new link does not ask (or bill) again.
 */
export async function assertIdentityVerificationCleared(client: GateClient, ctx: { tenant_id: string; signer_id: string }): Promise<void> {
  const s = await client.signer.findFirst({
    where: { id: ctx.signer_id, tenant_id: ctx.tenant_id },
    select: { identity_verification_method: true, identity_verification_locked_at: true },
  });
  if (s === null || s.identity_verification_method === null) return;
  if (s.identity_verification_locked_at !== null) throw new SignerIdentityVerificationLockedError(ctx.signer_id);
  const verified = await client.signRecipientIdentityVerification.count({
    where: { tenant_id: ctx.tenant_id, signer_id: ctx.signer_id, method: s.identity_verification_method, status: 'VERIFIED' },
  });
  if (verified === 0) throw new SignerIdentityVerificationRequiredError(ctx.signer_id, s.identity_verification_method as IdentityVerificationMethod);
}

/**
 * SIGN_ID_VERIFICATION_PROVIDER — unset (the default) or `disabled` ⇒ the disabled adapter;
 * `stripe_identity` ⇒ Stripe Identity (SIGN_STRIPE_IDENTITY_*). Any other value is disabled
 * (fail closed). Stripe Identity with a missing key or webhook secret reports itself not
 * configured and every start is refused.
 */
export function identityVerificationProviderFromEnv(env: NodeJS.ProcessEnv = process.env): IdentityVerificationPort {
  const requested = (env['SIGN_ID_VERIFICATION_PROVIDER'] ?? '').trim().toLowerCase();
  if (requested === 'stripe_identity') return new StripeIdentityAdapter(env);
  return new DisabledIdentityVerificationAdapter();
}
