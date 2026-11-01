// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §5 D-2 + Amendment A1 (D-8 amended) —
// metered Sign features report each billable unit through this minimal port. The usage-metering
// model itself (per-unit pricing and billing) is built separately; until it binds a real
// recorder, the composition root binds the no-op recorder below and nothing is billed.
//
// A recorder must be idempotent on idempotency_key: a retried call never counts twice.

export const SIGN_USAGE_RECORDER_PORT = 'SIGN_USAGE_RECORDER_PORT';

/** Metered unit keys reported by recipient verification. */
export const SIGN_ID_VERIFICATION_ATTEMPT_METER = 'sign.id_verification.attempt';
export const SIGN_KBA_ATTEMPT_METER = 'sign.kba.attempt';

export interface SignUsageEvent {
  tenant_id: string;
  meter_key: string;
  quantity: number;
  idempotency_key: string;
  occurred_at: Date;
  envelope_id?: string;
}

export interface SignUsageRecorderPort {
  record(event: SignUsageEvent): Promise<void>;
}

export class NoopSignUsageRecorder implements SignUsageRecorderPort {
  record(): Promise<void> {
    return Promise.resolve();
  }
}
