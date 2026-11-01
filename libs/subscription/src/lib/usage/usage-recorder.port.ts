// Sign usage / metered billing (Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §3 item 2,
// §5 D-2; Amendment A1 §A1.1) — the port every metered feature calls. SMS and WhatsApp delivery,
// SMS OTP, ID verification, KBA, QES and India e-stamp depend on THIS interface only; the
// implementation (MeteredUsageService) is bound by SubscriptionModule under USAGE_RECORDER.
//
// How a feature uses it (fail closed):
//
//   1. BEFORE the vendor call (the cost is incurred there), ask whether the tenant may be billed
//      for the unit:
//          const ok = await recorder.check({ tenant_id, unit: 'sign.sms_message' });
//          if (!ok.ok) → refuse the feature call (ok.reason is stable; nothing is sent).
//   2. AFTER the vendor accepted the work, record it, with an idempotency key that is stable for
//      that billable event (a retry of the same event must reuse it):
//          const r = await recorder.record({
//            tenant_id, unit: 'sign.sms_message', quantity: 1,
//            idempotency_key: `sign:sms:${envelope_id}:${recipient_id}:${attempt_no}`,
//            source_ref: `sign:envelope:${envelope_id}`,
//          });
//      r.ok && r.replayed → the event was already recorded (no second charge).
//      !r.ok → a refusal (the unit stopped being sold, billing was switched off, the subscription
//      stopped sending, or the key was reused for a different event). The caller logs it and
//      must not retry with a new key.
//
// Rules:
//   - unit: one of METERED_UNIT_KEYS (sign.sms_message, sign.whatsapp_message, sign.sms_otp,
//     sign.id_verification, sign.kba, sign.qes_signature, sign.india_estamp). Any other value is
//     refused UNKNOWN_UNIT.
//   - quantity: an integer 1..100000.
//   - idempotency_key: 1..200 characters, unique per tenant for ONE billable event. The same key
//     with the same unit, quantity and source_ref replays; with anything different it is refused
//     IDEMPOTENCY_CONFLICT.
//   - source_ref: 1..300 characters, an opaque Aramo reference (e.g. sign:envelope:<uuid>). NEVER
//     a phone number, an email address, a name or any other personal data.
//   - occurred_at (optional, default now): within the last 35 days and at most 5 minutes ahead.
//   - The price is never supplied by the caller: it is the unit price on the tenant's PINNED plan
//     version (catalog data). A unit with no price there is refused UNIT_NOT_SOLD.
//   - While SIGN_USAGE_BILLING_ENABLED is not '1', check() and record() refuse
//     USAGE_BILLING_DISABLED (built dark).

export const USAGE_RECORDER = 'USAGE_RECORDER';

export type UsageRefusalReason =
  | 'USAGE_BILLING_DISABLED'
  | 'UNKNOWN_UNIT'
  | 'INVALID_INPUT'
  | 'NOT_SUBSCRIBED'
  | 'UNIT_NOT_SOLD'
  | 'IDEMPOTENCY_CONFLICT';

export interface UsageCheckInput {
  readonly tenant_id: string;
  readonly unit: string;
}

export interface UsageRecordInput {
  readonly tenant_id: string;
  readonly unit: string;
  readonly quantity: number;
  readonly idempotency_key: string;
  readonly source_ref: string;
  readonly occurred_at?: Date;
}

export interface UsageRefusal {
  readonly ok: false;
  readonly reason: UsageRefusalReason;
  readonly message: string;
}

export type UsageCheckResult =
  | {
      readonly ok: true;
      readonly unit: string;
      readonly unit_price_minor: number;
      readonly currency: string;
      readonly plan_version_id: string;
    }
  | UsageRefusal;

export type UsageRecordResult =
  | {
      readonly ok: true;
      readonly entry_id: string;
      /** true when this idempotency key was already recorded (nothing new was charged). */
      readonly replayed: boolean;
      readonly unit: string;
      readonly quantity: number;
      readonly unit_price_minor: number;
      readonly amount_minor: number;
      readonly currency: string;
      readonly period_start: Date;
      readonly period_end: Date;
    }
  | UsageRefusal;

export interface UsageRecorder {
  /** May the tenant be billed for `unit` now? Read only. */
  check(input: UsageCheckInput): Promise<UsageCheckResult>;
  /** Append one billable event to the usage ledger (idempotent on tenant_id + idempotency_key). */
  record(input: UsageRecordInput): Promise<UsageRecordResult>;
}
