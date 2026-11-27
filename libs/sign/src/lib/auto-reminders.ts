// SIGN-FREE-PARITY-1 S4 (FP-R5) — automatic reminders, server side. The cadence itself
// (2 days, then every 3, at most 5) is @aramo/sign-client's AUTO_REMINDER_CADENCE, the one
// copy the worker, the send path and both Sign apps read.
//
// The send-time check verdict. A system reminder has no IP of its own, so it reuses the
// verdict recorded when the envelope was sent and is NEVER re-checked against the Personal
// young-account rule:
//   ALLOWED   — a Personal send that passed the check (a refused send is never sent, so it
//               never has a verdict);
//   NOT_GATED — a Business send (Business accounts are not risk-checked).
// No verdict recorded (envelopes sent before S4, or by another application) = no automatic
// reminders.
export { AUTO_REMINDER_CADENCE, autoReminderDueAt, autoReminderAfterSent, autoReminderOnEnable } from '@aramo/sign-client';

export const SEND_RISK_VERDICTS = ['ALLOWED', 'NOT_GATED'] as const;
export type SendRiskVerdict = (typeof SEND_RISK_VERDICTS)[number];

/** True when the recorded send-time verdict lets the worker send an automatic reminder. */
export function autoReminderVerdictAllows(verdict: string | null | undefined): boolean {
  return verdict === 'ALLOWED' || verdict === 'NOT_GATED';
}

/** The actor recorded on an automatic reminder's ledger event (the system, no user). */
export const AUTO_REMINDER_ACTOR_TYPE = 'SYSTEM';

/** What one worker attempt did with a due envelope. */
export type AutoReminderOutcome =
  | { kind: 'sent'; sent_count: number; next_at: Date | null }
  | { kind: 'rescheduled'; next_at: Date; reason: string }
  | { kind: 'stopped'; reason: string }
  | { kind: 'skipped' };
