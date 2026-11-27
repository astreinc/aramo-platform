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

// SIGN-FREE-PARITY-1 S4 (FP-R5) — automatic reminders. ONE cadence for the server (the
// sign-service worker and the send path) and the words both Sign apps show. The first
// reminder goes 2 days after sending, then one every 3 days, at most 5 per envelope. The
// sender can turn them off (or back on) per envelope, while drafting or after sending. They
// stop when the envelope is completed, declined, voided or expires.

export const AUTO_REMINDER_DAY_MS = 86_400_000;

export const AUTO_REMINDER_CADENCE = {
  /** Days from sending to the first automatic reminder. */
  first_after_days: 2,
  /** Days between automatic reminders after the first. */
  every_days: 3,
  /** Automatic reminders per envelope, at most. */
  max_count: 5,
} as const;

/** Statuses in which the sender can turn automatic reminders on or off. */
export const AUTO_REMINDER_SETTABLE_STATUSES: readonly string[] = ['DRAFT', 'SENT', 'IN_PROGRESS'];

/** True when the sender can still change the setting. A self-signed envelope has no one to remind. */
export function canSetAutoReminders(env: { readonly status: string; readonly mode?: string | null; readonly envelope_mode?: string | null }): boolean {
  if ((env.mode ?? '').toLowerCase() === 'self' || env.envelope_mode === 'SELF') return false;
  return AUTO_REMINDER_SETTABLE_STATUSES.includes(env.status);
}

function toMs(at: Date | string | number): number {
  return at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
}

/**
 * When automatic reminder number `sent_count + 1` is due on the plain cadence from the send
 * time: sent + 2 days, then every 3 days. null once the maximum has been sent.
 */
export function autoReminderDueAt(sent_at: Date | string | number, sent_count: number): Date | null {
  if (sent_count >= AUTO_REMINDER_CADENCE.max_count) return null;
  const days = AUTO_REMINDER_CADENCE.first_after_days + Math.max(0, sent_count) * AUTO_REMINDER_CADENCE.every_days;
  return new Date(toMs(sent_at) + days * AUTO_REMINDER_DAY_MS);
}

/** After an automatic reminder went out (now `sent_count` in all): the next one is 3 days later, or none. */
export function autoReminderAfterSent(now: Date | string | number, sent_count: number): Date | null {
  if (sent_count >= AUTO_REMINDER_CADENCE.max_count) return null;
  return new Date(toMs(now) + AUTO_REMINDER_CADENCE.every_days * AUTO_REMINDER_DAY_MS);
}

/**
 * Turned back on after sending: the next one is due on the plain cadence, or now when that
 * time has already passed. null once the maximum has been sent.
 */
export function autoReminderOnEnable(sent_at: Date | string | number, sent_count: number, now: Date | string | number): Date | null {
  const due = autoReminderDueAt(sent_at, sent_count);
  if (due === null) return null;
  return due.getTime() > toMs(now) ? due : new Date(toMs(now));
}

/** The automatic reminder state on a sender envelope detail. */
export interface AutoRemindersView {
  readonly enabled: boolean;
  readonly sent_count: number;
  readonly max_count: number;
  /** ISO time of the next automatic reminder; null when none is planned. */
  readonly next_at: string | null;
}

export const AUTO_REMINDER_COPY = {
  label: 'Automatic reminders',
  help: `Remind signers ${AUTO_REMINDER_CADENCE.first_after_days} days after sending, then every ${AUTO_REMINDER_CADENCE.every_days} days (up to ${AUTO_REMINDER_CADENCE.max_count}).`,
  turn_off: 'Turn off',
  turn_on: 'Turn on',
  off: 'Automatic reminders are off.',
  on: 'Automatic reminders are on.',
  all_sent: `All ${AUTO_REMINDER_CADENCE.max_count} automatic reminders were sent.`,
  turned_off: 'Automatic reminders turned off.',
  turned_on: 'Automatic reminders turned on.',
} as const;

/** One line for the envelope detail. `formatDate` renders the ISO time in the app's style. */
export function autoReminderStatusLine(view: AutoRemindersView | null | undefined, formatDate: (iso: string) => string): string | null {
  if (view === null || view === undefined) return null;
  if (!view.enabled) return AUTO_REMINDER_COPY.off;
  if (view.next_at !== null) return `${AUTO_REMINDER_COPY.on} Next one: ${formatDate(view.next_at)}.`;
  if (view.sent_count >= view.max_count) return AUTO_REMINDER_COPY.all_sent;
  return AUTO_REMINDER_COPY.on;
}
