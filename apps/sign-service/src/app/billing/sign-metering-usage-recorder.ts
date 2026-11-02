import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { SignUsageRecord, SignUsageRecorderPort } from '@aramo/sign';
import { USAGE_RECORDER, usageBillingEnabled, type UsageRecorder } from '@aramo/subscription';

// Sign usage metering (Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §5 D-2; Amendment
// A1 §A1.1; Amendment A3 D1/D3) — binds the Sign engine's ONE usage port (SIGN_USAGE_RECORDER_PORT:
// SMS / WhatsApp signing links and SMS one-time passcodes from SignMessagingService, ID
// verification attempts from IdentityVerificationService) to the metering ledger
// (libs/subscription UsageRecorder → the append-only, idempotent UsageLedgerEntry).
//
// DARK: while SIGN_USAGE_BILLING_ENABLED is not '1' nothing is recorded (the ledger would refuse
// USAGE_BILLING_DISABLED anyway; this skips the call). A refusal (unit not sold on the plan,
// no subscription, closed period, …) is logged with its stable reason and never blocks the
// recipient's flow. The ledger prices the event; the caller never supplies a price.

/** Test seam: the env the flag is read from (production binds none). */
export const SIGN_METERING_RECORDER_ENV = 'SIGN_METERING_RECORDER_ENV';

/** The opaque source reference of a usage record (never personal data). */
export function usageSourceRef(u: Pick<SignUsageRecord, 'envelope_id' | 'unit'>): string {
  return u.envelope_id !== undefined ? `sign:envelope:${u.envelope_id}` : `sign:unit:${u.unit}`;
}

@Injectable()
export class SignMeteringUsageRecorder implements SignUsageRecorderPort {
  private readonly logger = new Logger(SignMeteringUsageRecorder.name);
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    @Inject(USAGE_RECORDER) private readonly ledger: UsageRecorder,
    @Optional() @Inject(SIGN_METERING_RECORDER_ENV) env?: NodeJS.ProcessEnv,
  ) {
    this.env = env ?? process.env;
  }

  async record(u: SignUsageRecord): Promise<void> {
    if (!usageBillingEnabled(this.env)) return;
    const r = await this.ledger.record({
      tenant_id: u.tenant_id,
      unit: u.unit,
      quantity: u.quantity,
      idempotency_key: u.idempotency_key,
      source_ref: usageSourceRef(u),
      occurred_at: u.occurred_at,
    });
    if (!r.ok) this.logger.warn(`usage not recorded (${r.reason}) for ${u.unit} under ${u.idempotency_key}`);
  }
}
