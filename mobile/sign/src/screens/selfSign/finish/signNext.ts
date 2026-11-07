// M-A14 §1 item 8 (a17) — which inbox item "Sign Next" offers, and how it is described.
// GET /v1/sign/inbox already says what the user may do: the first item with can_sign.
import type { InboxItem, InboxList } from '../../../features/inbox/types';

/** The first item the user may sign now, in the server's order (waiting first). */
export function firstSignable(inbox: InboxList | undefined | null): InboxItem | null {
  if (!inbox) return null;
  const all = [...(inbox.waiting ?? []), ...(inbox.other ?? []), ...(inbox.completed ?? [])];
  return all.find((i) => i.can_sign === true) ?? null;
}

/** "Nov 2, 2026 at 9:02 AM" in the device locale; null when the date is missing or bad. */
export function sentLabel(iso: string | null | undefined, locale?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const date = d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  return `${date} at ${time}`;
}
