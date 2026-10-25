import { ReminderLimitError } from './domain/envelope-contract-errors.js';
import type { LockingTx } from './esign.repository.js';

// Aramo Sign Mobile — reminder limits (Aramo-Sign-Unified-Product-Amendment-M-A3
// §7, amending the Standalone authorization): at least 60 minutes between
// reminders to the same signer, and at most 5 reminders per envelope in any
// rolling 24 hours. The same limits for web and mobile. The history is the
// SIGNATURE_REMINDER_SENT ledger itself, read under the envelope row lock.

export interface ReminderLimits {
  per_signer_cooldown_ms: number;
  per_envelope_window_ms: number;
  per_envelope_max: number;
}

export const SIGN_REMINDER_LIMITS: Readonly<ReminderLimits> = {
  per_signer_cooldown_ms: 60 * 60 * 1000,
  per_envelope_window_ms: 24 * 60 * 60 * 1000,
  per_envelope_max: 5,
};

export interface ReminderHistoryEntry {
  occurred_at: Date;
  // The reminded signers; null for reminders recorded before signer ids were kept
  // (those count against every signer, the conservative reading).
  signer_ids: string[] | null;
}

export async function reminderHistory(
  tx: Pick<LockingTx, 'signatureEvent'>,
  tenant_id: string,
  envelope_id: string,
  now: Date,
  limits: ReminderLimits,
): Promise<ReminderHistoryEntry[]> {
  const horizon = new Date(now.getTime() - Math.max(limits.per_envelope_window_ms, limits.per_signer_cooldown_ms));
  const rows = await tx.signatureEvent.findMany({
    where: { tenant_id, envelope_id, event_type: 'SIGNATURE_REMINDER_SENT', occurred_at: { gt: horizon } },
    orderBy: [{ occurred_at: 'asc' }, { id: 'asc' }],
    select: { occurred_at: true, payload: true },
  });
  return rows.map((r) => ({ occurred_at: r.occurred_at, signer_ids: signerIdsOf(r.payload) }));
}

function signerIdsOf(payload: unknown): string[] | null {
  if (payload === null || typeof payload !== 'object') return null;
  const ids = (payload as Record<string, unknown>)['signer_ids'];
  return Array.isArray(ids) && ids.every((x) => typeof x === 'string') ? (ids as string[]) : null;
}

// When this signer may next be reminded (null = now).
export function nextReminderAt(history: readonly ReminderHistoryEntry[], signer_id: string, now: Date, limits: ReminderLimits): Date | null {
  let last: Date | null = null;
  for (const h of history) {
    if (h.signer_ids !== null && !h.signer_ids.includes(signer_id)) continue;
    if (last === null || h.occurred_at > last) last = h.occurred_at;
  }
  if (last === null) return null;
  const at = new Date(last.getTime() + limits.per_signer_cooldown_ms);
  return at.getTime() > now.getTime() ? at : null;
}

// When the envelope's rolling window admits another reminder (null = now).
export function envelopeReminderAvailableAt(history: readonly ReminderHistoryEntry[], now: Date, limits: ReminderLimits): Date | null {
  const since = now.getTime() - limits.per_envelope_window_ms;
  const inWindow = history.filter((h) => h.occurred_at.getTime() > since);
  if (inWindow.length < limits.per_envelope_max) return null;
  // The window admits one more once enough of the oldest entries have aged out.
  const pivot = inWindow[inWindow.length - limits.per_envelope_max]!;
  return new Date(pivot.occurred_at.getTime() + limits.per_envelope_window_ms);
}

// The daily envelope limit refuses the whole call; the per-signer cooldown keeps
// only the targets that are out of their cooldown and refuses when none is.
export function applyReminderLimits(
  history: readonly ReminderHistoryEntry[],
  target_ids: readonly string[],
  now: Date,
  limits: ReminderLimits,
): { allowed: string[]; refused?: ReminderLimitError } {
  const daily = envelopeReminderAvailableAt(history, now, limits);
  if (daily !== null) return { allowed: [], refused: new ReminderLimitError('reminder_daily_limit', daily) };
  const allowed: string[] = [];
  let soonest: Date | null = null;
  for (const id of target_ids) {
    const at = nextReminderAt(history, id, now, limits);
    if (at === null) allowed.push(id);
    else if (soonest === null || at < soonest) soonest = at;
  }
  if (allowed.length === 0 && soonest !== null) return { allowed, refused: new ReminderLimitError('reminder_cooldown', soonest) };
  return { allowed };
}
