// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §5 D-2 / Amendment A1 §A1.1 (D-8
// amended) — the usage-metering HOOK. Metered Sign features report one usage record per
// billable unit through this interface. The usage-metering MODEL (per-unit billing, prices,
// aggregation) is built separately; this is the minimal seam it binds to. Unbound (the
// default today) = nothing is recorded, never an error.
//
// Contract for implementers:
//   - idempotency_key is unique per billable unit (a retried call must not count twice);
//   - record() must never throw into the caller's flow for a transient failure — the
//     caller treats a rejection as "not recorded" and logs it;
//   - quantity is a positive integer number of units.

export const SIGN_USAGE_RECORDER_PORT = 'SIGN_USAGE_RECORDER_PORT';

/** The Sign usage units reported today (messaging, §1.7 / §1.8 / §1.9). */
export type SignUsageUnit = 'sign.sms_message' | 'sign.whatsapp_message' | 'sign.sms_otp';

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
