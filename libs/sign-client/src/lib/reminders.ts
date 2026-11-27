// UAT SND-14 (field-test batch 1 §4 SND-1) — who a reminder reaches NOW, and when the next one
// can go, read from the server's per-recipient fields. ONE rule for sign-web and the Aramo Sign
// app (moved unchanged from mobile/sign envelopeActions.ts).
//
// The server's meaning of the two fields:
//   can_remind             — the signer may ever be reminded (unsigned, may sign now). It stays
//                            true while a reminder is cooling down.
//   reminder_available_at  — when the signer can be reminded again; null when a reminder may be
//                            sent now (or never applies).
// So a signer can be reminded now only when can_remind is true AND the cooldown has passed.
//
// Pure TypeScript ESM, no dependency (type:client-shared).

/** The per-recipient reminder fields of a sender envelope detail. */
export interface ReminderRow {
  readonly can_remind?: boolean;
  /** ISO time; null (or absent from an older server) when a reminder may be sent now. */
  readonly reminder_available_at?: string | null;
}

/** Signers a reminder would reach now: the server's `can_remind` and no pending cooldown. */
export function remindableNow<T extends ReminderRow>(recipients: readonly T[], now: number = Date.now()): T[] {
  return recipients.filter(
    (r) =>
      r.can_remind === true &&
      ((r.reminder_available_at ?? null) === null || Date.parse(r.reminder_available_at as string) <= now),
  );
}

/** The earliest time a reminder becomes possible among the `can_remind` signers (null: none waits). */
export function nextReminderAt(recipients: readonly ReminderRow[]): string | null {
  const times = recipients
    .filter((r) => r.can_remind === true && typeof r.reminder_available_at === 'string' && r.reminder_available_at !== '')
    .map((r) => r.reminder_available_at as string)
    .sort();
  return times[0] ?? null;
}
