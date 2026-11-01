// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §5 D-2 / Amendment A1 §A1.1 (D-8
// amended) / Amendment A3 (D1, D3) — the ONE usage-recording port of the Sign engine. Every
// metered Sign feature (SMS and WhatsApp signing links, SMS one-time passcodes, ID verification,
// KBA, QES, India e-stamp) reports one record per billable unit through this interface. The
// sign-service composition root binds it to the usage-metering ledger (libs/subscription
// UsageRecorder → UsageLedgerEntry), which records only while SIGN_USAGE_BILLING_ENABLED=1 and
// prices each event with the approved plan version effective at occurred_at. Unbound or dark =
// nothing is recorded, never an error.
//
// Contract for implementers and callers:
//   - unit is one of SIGN_USAGE_UNITS (the subscription MeteredUnit registry keys; a spec pins them);
//   - idempotency_key is unique per billable unit (a retried call must not count twice);
//   - record() must never throw into the caller's flow for a transient failure — the caller
//     treats a rejection as "not recorded" and logs it;
//   - quantity is a positive integer number of units;
//   - opaque ids only — never a phone number, an email address or a name.

export const SIGN_USAGE_RECORDER_PORT = 'SIGN_USAGE_RECORDER_PORT';

/** The Sign usage units (the MeteredUnit registry, migration 20261101300000_sign_usage_metering). */
export const SIGN_USAGE_UNITS = [
  'sign.sms_message',
  'sign.whatsapp_message',
  'sign.sms_otp',
  'sign.id_verification',
  'sign.kba',
  'sign.qes_signature',
  'sign.india_estamp',
] as const;
export type SignUsageUnit = (typeof SIGN_USAGE_UNITS)[number];

/** Recipient verification units (Feature Parity §1.9): one per started vendor attempt. */
export const SIGN_ID_VERIFICATION_ATTEMPT_METER: SignUsageUnit = 'sign.id_verification';
export const SIGN_KBA_ATTEMPT_METER: SignUsageUnit = 'sign.kba';

export interface SignUsageRecord {
  tenant_id: string;
  unit: SignUsageUnit;
  quantity: number;
  idempotency_key: string;
  occurred_at: Date;
  /** Optional context for reconciliation (opaque ids only, never personal data). */
  envelope_id?: string;
  provider?: string;
}

export interface SignUsageRecorderPort {
  record(usage: SignUsageRecord): Promise<void>;
}

/** The recorder used where no metering ledger is bound (tests, a module without SubscriptionModule). */
export class NoopSignUsageRecorder implements SignUsageRecorderPort {
  record(): Promise<void> {
    return Promise.resolve();
  }
}
