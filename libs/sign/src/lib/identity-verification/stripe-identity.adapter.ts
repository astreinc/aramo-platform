import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  type IdentityVerificationOutcome,
  type IdentityVerificationPort,
  type IdentityVerificationResult,
  IdentityVerificationUnavailableError,
  type IdentityVerificationWebhookEvent,
  IdentityVerificationWebhookSignatureError,
  type StartIdentityVerificationInput,
  type StartedIdentityVerification,
} from './identity-verification.port.js';

// Feature-Parity §1.9 / A1 — the D-3 default vendor: Stripe Identity VerificationSessions,
// over Stripe's REST API with no SDK (the same pattern as the billing provider in
// libs/subscription/src/lib/billing/stripe-billing.provider.ts), but with its OWN keys so
// identity verification never shares the billing account's credentials:
//
//   SIGN_STRIPE_IDENTITY_SECRET_KEY      restricted key (rk_…) with Identity read/write and
//                                        verified-outputs access only (secret; never commit)
//   SIGN_STRIPE_IDENTITY_WEBHOOK_SECRET  the identity webhook endpoint's signing secret (whsec_…)
//   SIGN_STRIPE_IDENTITY_API_BASE        optional override (tests point it at a local stand-in)
//
// The API version is pinned so response shapes are stable. Document checks only: no
// matching selfie is requested (no face geometry is collected), and no ID number or date
// of birth is requested. R-5: of the result only the outcome, the issuing country and —
// transiently, for the name comparison — the first and last name are read.

export const STRIPE_IDENTITY_API_VERSION = '2024-06-20';
export const STRIPE_IDENTITY_WEBHOOK_TOLERANCE_SEC = 300;

// The verification-session events that mean "the result may have changed".
const RESULT_EVENTS: ReadonlySet<string> = new Set([
  'identity.verification_session.verified',
  'identity.verification_session.requires_input',
  'identity.verification_session.canceled',
]);

function form(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** Stripe-Signature `t=<unix>,v1=<hex>` = HMAC-SHA256(secret, `${t}.${raw}`), constant time, ±300 s. */
export function verifyStripeIdentitySignature(rawBody: Buffer, header: string | undefined, secret: string | undefined, nowSec: number): void {
  if (secret === undefined || secret.length === 0) throw new IdentityVerificationWebhookSignatureError('NO_SECRET');
  if (header === undefined || header.length === 0) throw new IdentityVerificationWebhookSignatureError('MISSING');
  let t: string | null = null;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') sigs.push(v);
  }
  if (t === null || !/^\d{1,12}$/.test(t) || sigs.length === 0) throw new IdentityVerificationWebhookSignatureError('MALFORMED');
  if (Math.abs(nowSec - Number(t)) > STRIPE_IDENTITY_WEBHOOK_TOLERANCE_SEC) throw new IdentityVerificationWebhookSignatureError('STALE');
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex'), 'utf8');
  const ok = sigs.some((s) => {
    const provided = Buffer.from(s, 'utf8');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
  if (!ok) throw new IdentityVerificationWebhookSignatureError('BAD_SIGNATURE');
}

/**
 * A Stripe VerificationSession (verified_outputs and last_verification_report expanded) →
 * the port's minimal result. Everything else in the object is ignored.
 */
export function stripeIdentityResult(obj: Record<string, unknown>): IdentityVerificationResult {
  const status = String(obj['status'] ?? '');
  const lastError = obj['last_error'] as { code?: unknown } | null | undefined;
  const outputs = obj['verified_outputs'] as { first_name?: unknown; last_name?: unknown } | null | undefined;
  const report = obj['last_verification_report'];
  const reportDoc =
    report !== null && typeof report === 'object' ? ((report as { document?: { issuing_country?: unknown; first_name?: unknown; last_name?: unknown } | null }).document ?? null) : null;
  let outcome: IdentityVerificationOutcome;
  if (status === 'verified') outcome = 'VERIFIED';
  else if (status === 'canceled') outcome = 'CANCELLED';
  else if (status === 'requires_input' && lastError !== null && lastError !== undefined) outcome = 'FAILED';
  else outcome = 'PENDING'; // requires_input without an error (not finished) | processing
  const first = str(outputs?.first_name) ?? str(reportDoc?.first_name);
  const last = str(outputs?.last_name) ?? str(reportDoc?.last_name);
  const country = str(reportDoc?.issuing_country);
  return {
    vendor_reference: String(obj['id'] ?? ''),
    outcome,
    verified_name: outcome === 'VERIFIED' && first !== null && last !== null ? { first, last } : null,
    document_country: country !== null && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null,
    failure_code: outcome === 'FAILED' ? (str(lastError?.code) ?? 'unverified') : null,
  };
}

export class StripeIdentityAdapter implements IdentityVerificationPort {
  readonly provider = 'STRIPE_IDENTITY' as const;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private secretKey(): string | undefined {
    const k = this.env['SIGN_STRIPE_IDENTITY_SECRET_KEY'];
    return k === undefined || k.trim() === '' ? undefined : k.trim();
  }

  private webhookSecret(): string | undefined {
    const k = this.env['SIGN_STRIPE_IDENTITY_WEBHOOK_SECRET'];
    return k === undefined || k.trim() === '' ? undefined : k.trim();
  }

  private base(): string {
    return (this.env['SIGN_STRIPE_IDENTITY_API_BASE'] ?? 'https://api.stripe.com').replace(/\/+$/, '');
  }

  isConfigured(): boolean {
    return this.secretKey() !== undefined && this.webhookSecret() !== undefined;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: string, idempotencyKey?: string): Promise<Record<string, unknown>> {
    const key = this.secretKey();
    if (key === undefined) throw new IdentityVerificationUnavailableError('provider_not_configured');
    let res: Response;
    try {
      res = await fetch(`${this.base()}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          'stripe-version': STRIPE_IDENTITY_API_VERSION,
          ...(body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(idempotencyKey !== undefined ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body,
      });
    } catch {
      throw new IdentityVerificationUnavailableError('provider_unreachable', true);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // The vendor's message is not echoed (it may quote request data); only the status.
      throw new IdentityVerificationUnavailableError(`provider_http_${res.status}`, res.status === 429 || res.status >= 500);
    }
    return json;
  }

  private sessionPath(vendor_reference: string): string {
    return `/v1/identity/verification_sessions/${encodeURIComponent(vendor_reference)}`;
  }

  async startSession(input: StartIdentityVerificationInput): Promise<StartedIdentityVerification> {
    const obj = await this.call(
      'POST',
      '/v1/identity/verification_sessions',
      form({
        type: 'document',
        'options[document][require_matching_selfie]': 'false',
        'options[document][require_id_number]': 'false',
        'options[document][require_live_capture]': 'true',
        'options[document][allowed_types][0]': 'driving_license',
        'options[document][allowed_types][1]': 'passport',
        'options[document][allowed_types][2]': 'id_card',
        return_url: input.return_url,
        // Opaque Aramo ids only — no name, email or document data is sent.
        'metadata[aramo_attempt_id]': input.attempt_id,
        'metadata[aramo_tenant_id]': input.tenant_id,
        'metadata[aramo_envelope_id]': input.envelope_id,
        'metadata[aramo_signer_id]': input.signer_id,
      }),
      `aramo-sign-idv-${input.attempt_id}`,
    );
    const ref = str(obj['id']);
    const url = str(obj['url']);
    if (ref === null || url === null) throw new IdentityVerificationUnavailableError('provider_response_invalid');
    return { vendor_reference: ref, verification_url: url };
  }

  async resumeUrl(vendor_reference: string): Promise<string | null> {
    const obj = await this.call('GET', this.sessionPath(vendor_reference));
    // Only an unfinished session with no error can be resumed; its url is present then.
    if (obj['status'] !== 'requires_input' || (obj['last_error'] !== null && obj['last_error'] !== undefined)) return null;
    return str(obj['url']);
  }

  async retrieveResult(vendor_reference: string): Promise<IdentityVerificationResult> {
    const q = `${encodeURIComponent('expand[]')}=verified_outputs&${encodeURIComponent('expand[]')}=last_verification_report`;
    const obj = await this.call('GET', `${this.sessionPath(vendor_reference)}?${q}`);
    return stripeIdentityResult(obj);
  }

  async cancelSession(vendor_reference: string): Promise<void> {
    await this.call('POST', `${this.sessionPath(vendor_reference)}/cancel`, '', `aramo-sign-idv-cancel-${vendor_reference}`);
  }

  async redactSession(vendor_reference: string): Promise<void> {
    await this.call('POST', `${this.sessionPath(vendor_reference)}/redact`, '', `aramo-sign-idv-redact-${vendor_reference}`);
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, nowSec: number): IdentityVerificationWebhookEvent {
    verifyStripeIdentitySignature(rawBody, signatureHeader, this.webhookSecret(), nowSec);
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new IdentityVerificationWebhookSignatureError('MALFORMED');
    }
    const type = String(evt['type'] ?? '');
    const object = (evt['data'] as { object?: Record<string, unknown> } | undefined)?.object;
    const ref = object !== undefined && object['object'] === 'identity.verification_session' ? str(object['id']) : null;
    return { event_ref: String(evt['id'] ?? ''), kind: RESULT_EVENTS.has(type) && ref !== null ? 'RESULT_AVAILABLE' : 'IGNORED', vendor_reference: ref };
  }
}
