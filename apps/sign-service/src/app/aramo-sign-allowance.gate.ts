import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { EsignRepository } from '@aramo/sign';
import {
  AllowanceService,
  ESIGN_ENVELOPE_ALLOWANCE,
  ESIGN_ENVELOPE_SENT_EVENT,
  type AllowanceReadResult,
  type AllowanceUnavailableReason,
} from '@aramo/subscription';

// Multi-Provider directive §B/§C — the Aramo Sign allowance at the native send seam.
// It wraps the provider's send (every caller — ATS RTR/Offer through the internal
// zone and the sender console — reaches sendEnvelope), and stays OUTSIDE the
// envelope lifecycle: libs/sign transitions are untouched (Independent-Platform
// directive: no plan decisions in envelope state transitions).
//
//   reserve (refuse at the limit) → send → consume once the envelope is accepted
//   (SENT or later); release if the send failed and the envelope is still a DRAFT.
// The send identity is the envelope id, so a retry of the same envelope never
// charges twice.

const SEND_KEY_PREFIX = 'aramo-sign:envelope:';

export function aramoSignSendKey(envelope_id: string): string {
  return `${SEND_KEY_PREFIX}${envelope_id}`;
}

function refusal(reason: AllowanceUnavailableReason, status: AllowanceReadResult): AramoError {
  if (reason === 'NOT_SUBSCRIBED') {
    return new AramoError('ESIGN_NOT_SUBSCRIBED', 'Sending needs an Aramo Sign subscription', 403, {
      requestId: '',
      details: { reason },
    });
  }
  const s = status.subscribed ? status : null;
  // Personal Free v1.1 §4 — the day window (only plans configured with one).
  if (reason === 'DAILY_LIMIT_REACHED') {
    return new AramoError('ESIGN_ALLOWANCE_EXHAUSTED', 'The daily envelope limit is reached', 409, {
      requestId: '',
      details: {
        reason,
        window: 'DAY',
        limit: s?.daily?.limit ?? null,
        used: s?.daily?.used ?? null,
        next_available_at: s?.daily?.next_available_at?.toISOString() ?? null,
      },
    });
  }
  return new AramoError('ESIGN_ALLOWANCE_EXHAUSTED', 'The Aramo Sign envelope allowance for this period is used up', 409, {
    requestId: '',
    details: {
      reason,
      limit: s?.limit ?? null,
      used: s?.used ?? null,
      period_end: s?.period_end.toISOString() ?? null,
    },
  });
}

@Injectable()
export class AramoSignAllowanceGate {
  constructor(
    private readonly allowance: AllowanceService,
    private readonly repo: EsignRepository,
  ) {}

  private async accepted(tenant_id: string, envelope_id: string): Promise<boolean> {
    const env = await this.repo.getEnvelope(tenant_id, envelope_id);
    return env.status !== 'DRAFT';
  }

  async guardSend<T>(tenant_id: string, envelope_id: string, send: () => Promise<T>): Promise<T> {
    const key = { tenant_id, allowance_key: ESIGN_ENVELOPE_ALLOWANCE };
    // Overdue reservations are settled from the envelope record before counting.
    await this.allowance.resolveStale({
      ...key,
      usage_event_type: ESIGN_ENVELOPE_SENT_EVENT,
      outcome: async (send_key) => {
        if (!send_key.startsWith(SEND_KEY_PREFIX)) return 'UNKNOWN';
        try {
          return (await this.accepted(tenant_id, send_key.slice(SEND_KEY_PREFIX.length))) ? 'ACCEPTED' : 'NOT_ACCEPTED';
        } catch {
          return 'UNKNOWN';
        }
      },
    });

    const send_key = aramoSignSendKey(envelope_id);
    const reserved = await this.allowance.reserve({ ...key, send_key });
    if (!reserved.ok) throw refusal(reserved.reason, reserved.status);

    try {
      const result = await send();
      await this.allowance.consume({ ...key, send_key, usage_event_type: ESIGN_ENVELOPE_SENT_EVENT });
      return result;
    } catch (err) {
      // Settle the reservation from the envelope itself: accepted sends stay charged.
      let isAccepted: boolean | null = null;
      try {
        isAccepted = await this.accepted(tenant_id, envelope_id);
      } catch {
        isAccepted = null; // unknown: the reservation stays counted until resolved
      }
      if (isAccepted === true) {
        await this.allowance.consume({ ...key, send_key, usage_event_type: ESIGN_ENVELOPE_SENT_EVENT });
      } else if (isAccepted === false) {
        await this.allowance.release({ ...key, send_key });
      }
      throw err;
    }
  }
}
