import { createHmac, timingSafeEqual } from 'node:crypto';

import { EVENT_VERSION, GOLDEN_TALENT_PROFILE_UPDATED, SOURCE_SYSTEM_IDS, type EventVersion, type SourceSystemId } from './events.js';

// ATI-SEP-1 T7 (ADR-0036 §3 "TI → ATS") — the HMAC-signed webhook TI sends to
// POST /v1/integrations/intelligence/events on the ATS. ONE definition shared by
// the signer (apps/talent-intelligence-service) and the verifier (the ATS
// receiver, T8), so the canonical form cannot drift between the two sides.
//
// Scheme `aramo-intelligence-webhook-v1` (mirrors aramo-sign-s2s-v1 and the
// sign-service lifecycle webhook): HMAC-SHA256 (base64) over
//
//     aramo-intelligence-webhook-v1 \n timestamp \n rawBody
//
// keyed by INTELLIGENCE_WEBHOOK_SIGNING_SECRET. rawBody is the EXACT byte string
// POSTed (never a re-serialized object). The scheme tag gives domain separation
// from every other Aramo HMAC (a sign webhook message starts with digits + '.',
// an s2s message with its own tag), and the headers are distinct as well.
//
// Recorded residual (same as aramo-sign-s2s-v1): no nonce store — a captured
// IDENTICAL delivery can be replayed inside the ±tolerance window. The receiver
// dedupes on event_id (each delivery has its own), so a replay is a no-op.

export const INTELLIGENCE_WEBHOOK_SCHEME = 'aramo-intelligence-webhook-v1';
export const INTELLIGENCE_WEBHOOK_TIMESTAMP_HEADER = 'x-aramo-intelligence-timestamp';
export const INTELLIGENCE_WEBHOOK_SIGNATURE_HEADER = 'x-aramo-intelligence-signature';
export const INTELLIGENCE_WEBHOOK_TIMESTAMP_TOLERANCE_SEC = 300;
export const INTELLIGENCE_WEBHOOK_SIGNING_SECRET_ENV = 'INTELLIGENCE_WEBHOOK_SIGNING_SECRET';
export const INTELLIGENCE_ATS_WEBHOOK_URL_ENV = 'INTELLIGENCE_ATS_WEBHOOK_URL';

export type IntelligenceWebhookVerifyReason = 'NO_SECRET' | 'MISSING' | 'MALFORMED' | 'STALE' | 'BAD_SIGNATURE';

export interface IntelligenceWebhookVerifyResult {
  ok: boolean;
  reason?: IntelligenceWebhookVerifyReason;
}

export function canonicalIntelligenceWebhookMessage(timestamp: string, rawBody: string): string {
  return `${INTELLIGENCE_WEBHOOK_SCHEME}\n${timestamp}\n${rawBody}`;
}

export function computeIntelligenceWebhookSignature(timestamp: string, rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(canonicalIntelligenceWebhookMessage(timestamp, rawBody), 'utf8').digest('base64');
}

/** Signer side: the headers to attach to a POST of exactly `rawBody`. */
export function signIntelligenceWebhook(input: { rawBody: string; secret: string; nowSec: number }): Record<string, string> {
  if (input.secret.length === 0) throw new Error('intelligence webhook: a signing secret is required');
  const timestamp = String(Math.floor(input.nowSec));
  return {
    [INTELLIGENCE_WEBHOOK_TIMESTAMP_HEADER]: timestamp,
    [INTELLIGENCE_WEBHOOK_SIGNATURE_HEADER]: computeIntelligenceWebhookSignature(timestamp, input.rawBody, input.secret),
  };
}

/** Verifier side. Fail-closed order: secret → presence → timestamp shape → window → length → constant-time compare. */
export function verifyIntelligenceWebhook(input: {
  rawBody: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  secret: string | undefined;
  nowSec: number;
  toleranceSec?: number;
}): IntelligenceWebhookVerifyResult {
  const tolerance = input.toleranceSec ?? INTELLIGENCE_WEBHOOK_TIMESTAMP_TOLERANCE_SEC;
  if (input.secret === undefined || input.secret.length === 0) return { ok: false, reason: 'NO_SECRET' };
  const ts = input.timestampHeader;
  const sig = input.signatureHeader;
  if (ts === undefined || ts.length === 0 || sig === undefined || sig.length === 0) return { ok: false, reason: 'MISSING' };
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: 'MALFORMED' };
  if (Math.abs(input.nowSec - Number(ts)) > tolerance) return { ok: false, reason: 'STALE' };
  const expected = Buffer.from(computeIntelligenceWebhookSignature(ts, input.rawBody, input.secret), 'utf8');
  const provided = Buffer.from(sig, 'utf8');
  if (expected.length !== provided.length) return { ok: false, reason: 'BAD_SIGNATURE' };
  return timingSafeEqual(expected, provided) ? { ok: true } : { ok: false, reason: 'BAD_SIGNATURE' };
}

/**
 * The webhook body: the event envelope + the ONE source reference this delivery
 * is for. TI sends one delivery per ACTIVE reference of an ENTITLED tenant.
 * Ids and fact-type names only — no PII, no value.
 */
export interface IntelligenceProfileUpdatedWebhook {
  /** Unique per delivery (receiver inbox key). */
  event_id: string;
  event_type: typeof GOLDEN_TALENT_PROFILE_UPDATED;
  event_version: EventVersion;
  intelligence_subject_id: string;
  occurred_at: string;
  source_system_id: SourceSystemId;
  source_tenant_id: string;
  external_talent_id: string;
  changed_fact_types: string[];
}

const WEBHOOK_KEYS = [
  'event_id',
  'event_type',
  'event_version',
  'intelligence_subject_id',
  'occurred_at',
  'source_system_id',
  'source_tenant_id',
  'external_talent_id',
  'changed_fact_types',
] as const;

/** Structural guard for the receiver: exactly the keys above, v1, ids non-empty. */
export function isIntelligenceProfileUpdatedWebhook(value: unknown): value is IntelligenceProfileUpdatedWebhook {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length !== WEBHOOK_KEYS.length || !WEBHOOK_KEYS.every((k) => k in r)) return false;
  if (r['event_type'] !== GOLDEN_TALENT_PROFILE_UPDATED || r['event_version'] !== EVENT_VERSION) return false;
  if (!(SOURCE_SYSTEM_IDS as readonly unknown[]).includes(r['source_system_id'])) return false;
  const ids = ['event_id', 'intelligence_subject_id', 'occurred_at', 'source_tenant_id', 'external_talent_id'] as const;
  if (!ids.every((k) => typeof r[k] === 'string' && (r[k] as string).length > 0)) return false;
  const changed = r['changed_fact_types'];
  return Array.isArray(changed) && changed.every((c) => typeof c === 'string');
}
