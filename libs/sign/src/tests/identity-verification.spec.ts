import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { DisabledIdentityVerificationAdapter, IdentityVerificationWebhookSignatureError } from '../lib/identity-verification/identity-verification.port.js';
import { StripeIdentityAdapter, stripeIdentityResult, verifyStripeIdentitySignature } from '../lib/identity-verification/stripe-identity.adapter.js';
import { DisabledKbaAdapter, kbaProviderFromEnv } from '../lib/identity-verification/kba.port.js';
import { verifiedNameMatches } from '../lib/identity-verification/name-match.js';
import {
  SignerIdentityVerificationLockedError,
  SignerIdentityVerificationRequiredError,
  assertIdentityVerificationCleared,
  idVerificationMaxAttempts,
  identityVerificationProviderFromEnv,
} from '../lib/identity-verification/identity-gate.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.9 + Amendment A1 — recipient
// identity verification: name-match policy, Stripe Identity webhook signature and result
// mapping, provider selection (dark by default) and the engine gate.

const SECRET = 'whsec_test';
function sign(body: string, t: number, secret = SECRET): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

describe('verifiedNameMatches (conservative policy)', () => {
  it('matches case, accents, punctuation and extra middle names', () => {
    expect(verifiedNameMatches({ first: 'JOSÉ', last: "O'Neil" }, 'Jose Maria O Neil')).toBe(true);
    expect(verifiedNameMatches({ first: 'Ana', last: 'García López' }, 'ana garcia lopez')).toBe(true);
  });
  it('refuses a different name, a missing family part or no verified name', () => {
    expect(verifiedNameMatches({ first: 'John', last: 'Smith' }, 'Jane Smith')).toBe(false);
    expect(verifiedNameMatches({ first: 'Ana', last: 'García López' }, 'Ana García')).toBe(false);
    expect(verifiedNameMatches(null, 'Ana García')).toBe(false);
    expect(verifiedNameMatches({ first: '', last: 'X' }, 'X')).toBe(false);
  });
});

describe('verifyStripeIdentitySignature', () => {
  const body = '{"id":"evt_1"}';
  it('accepts a valid signature within tolerance', () => {
    expect(() => verifyStripeIdentitySignature(Buffer.from(body), sign(body, 1000), SECRET, 1100)).not.toThrow();
  });
  it.each([
    ['NO_SECRET', sign(body, 1000), undefined, 1000],
    ['MISSING', undefined, SECRET, 1000],
    ['MALFORMED', 'v1=abc', SECRET, 1000],
    ['STALE', sign(body, 1000), SECRET, 1301],
    ['BAD_SIGNATURE', sign(body, 1000, 'whsec_other'), SECRET, 1000],
  ] as const)('rejects %s', (reason, header, secret, now) => {
    try {
      verifyStripeIdentitySignature(Buffer.from(body), header, secret, now);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(IdentityVerificationWebhookSignatureError);
      expect((e as IdentityVerificationWebhookSignatureError).reason).toBe(reason);
    }
  });
});

describe('stripeIdentityResult', () => {
  it('maps a verified session to the outcome, name (transient) and country only', () => {
    const r = stripeIdentityResult({
      id: 'vs_1',
      status: 'verified',
      verified_outputs: { first_name: 'Ana', last_name: 'Ruiz', dob: { year: 1990 }, id_number: '123' },
      last_verification_report: { document: { issuing_country: 'es', number: 'X1' } },
    });
    expect(r).toEqual({ vendor_reference: 'vs_1', outcome: 'VERIFIED', verified_name: { first: 'Ana', last: 'Ruiz' }, document_country: 'ES', failure_code: null });
  });
  it('maps requires_input with an error to FAILED, without one to PENDING, and canceled to CANCELLED', () => {
    expect(stripeIdentityResult({ id: 'vs_2', status: 'requires_input', last_error: { code: 'document_expired' } })).toMatchObject({ outcome: 'FAILED', failure_code: 'document_expired', verified_name: null });
    expect(stripeIdentityResult({ id: 'vs_3', status: 'requires_input', last_error: null }).outcome).toBe('PENDING');
    expect(stripeIdentityResult({ id: 'vs_4', status: 'processing' }).outcome).toBe('PENDING');
    expect(stripeIdentityResult({ id: 'vs_5', status: 'canceled' }).outcome).toBe('CANCELLED');
  });
});

describe('StripeIdentityAdapter.verifyWebhook', () => {
  const adapter = new StripeIdentityAdapter({ SIGN_STRIPE_IDENTITY_SECRET_KEY: 'rk_test', SIGN_STRIPE_IDENTITY_WEBHOOK_SECRET: SECRET });
  it('takes only the session id from a result event', () => {
    const body = JSON.stringify({ id: 'evt_9', type: 'identity.verification_session.verified', data: { object: { object: 'identity.verification_session', id: 'vs_9', status: 'verified' } } });
    expect(adapter.verifyWebhook(Buffer.from(body), sign(body, 50), 50)).toEqual({ event_ref: 'evt_9', kind: 'RESULT_AVAILABLE', vendor_reference: 'vs_9' });
  });
  it('ignores other event types', () => {
    const body = JSON.stringify({ id: 'evt_8', type: 'identity.verification_session.created', data: { object: { object: 'identity.verification_session', id: 'vs_8' } } });
    expect(adapter.verifyWebhook(Buffer.from(body), sign(body, 50), 50).kind).toBe('IGNORED');
  });
  it('is configured only with both the key and the webhook secret', () => {
    expect(adapter.isConfigured()).toBe(true);
    expect(new StripeIdentityAdapter({ SIGN_STRIPE_IDENTITY_SECRET_KEY: 'rk_test' }).isConfigured()).toBe(false);
  });
});

describe('provider selection (dark by default)', () => {
  it('is disabled unless stripe_identity is named', () => {
    expect(identityVerificationProviderFromEnv({})).toBeInstanceOf(DisabledIdentityVerificationAdapter);
    expect(identityVerificationProviderFromEnv({ SIGN_ID_VERIFICATION_PROVIDER: 'other' })).toBeInstanceOf(DisabledIdentityVerificationAdapter);
    expect(identityVerificationProviderFromEnv({ SIGN_ID_VERIFICATION_PROVIDER: 'stripe_identity' })).toBeInstanceOf(StripeIdentityAdapter);
  });
  it('KBA is always disabled (no vendor selected)', async () => {
    const kba = kbaProviderFromEnv({ SIGN_KBA_PROVIDER: 'anything' });
    expect(kba).toBeInstanceOf(DisabledKbaAdapter);
    expect(kba.isConfigured()).toBe(false);
    await expect(kba.startQuiz()).rejects.toThrow('kba_vendor_not_selected');
  });
  it('the disabled adapter refuses every call', async () => {
    const d = new DisabledIdentityVerificationAdapter();
    expect(d.isConfigured()).toBe(false);
    await expect(d.startSession()).rejects.toThrow('provider_not_configured');
    expect(() => d.verifyWebhook()).toThrow(IdentityVerificationWebhookSignatureError);
  });
  it('max attempts defaults to 3 and accepts 1..10', () => {
    expect(idVerificationMaxAttempts({})).toBe(3);
    expect(idVerificationMaxAttempts({ SIGN_ID_VERIFICATION_MAX_ATTEMPTS: '5' })).toBe(5);
    expect(idVerificationMaxAttempts({ SIGN_ID_VERIFICATION_MAX_ATTEMPTS: '0' })).toBe(3);
  });
});

describe('assertIdentityVerificationCleared', () => {
  const ctx = { tenant_id: 't', signer_id: 's' };
  function client(signer: { identity_verification_method: string | null; identity_verification_locked_at: Date | null } | null, verified: number) {
    return {
      signer: { findFirst: () => Promise.resolve(signer) },
      signRecipientIdentityVerification: { count: () => Promise.resolve(verified) },
    } as unknown as Parameters<typeof assertIdentityVerificationCleared>[0];
  }
  it('passes a recipient without a method', async () => {
    await expect(assertIdentityVerificationCleared(client({ identity_verification_method: null, identity_verification_locked_at: null }, 0), ctx)).resolves.toBeUndefined();
  });
  it('requires a VERIFIED attempt', async () => {
    await expect(assertIdentityVerificationCleared(client({ identity_verification_method: 'ID_VERIFICATION', identity_verification_locked_at: null }, 0), ctx)).rejects.toBeInstanceOf(
      SignerIdentityVerificationRequiredError,
    );
    await expect(assertIdentityVerificationCleared(client({ identity_verification_method: 'ID_VERIFICATION', identity_verification_locked_at: null }, 1), ctx)).resolves.toBeUndefined();
  });
  it('refuses a locked recipient', async () => {
    await expect(assertIdentityVerificationCleared(client({ identity_verification_method: 'ID_VERIFICATION', identity_verification_locked_at: new Date() }, 1), ctx)).rejects.toBeInstanceOf(
      SignerIdentityVerificationLockedError,
    );
  });
});
