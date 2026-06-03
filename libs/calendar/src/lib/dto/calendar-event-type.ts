// CalendarEventType — closed list mirroring the Prisma enum.
//
// Tier-2 locked vocabulary: all 6 values are domain-neutral. R12-clean.
export const CALENDAR_EVENT_TYPE_VALUES = [
  'call',
  'email',
  'meeting',
  'interview',
  'personal',
  'other',
] as const;

export type CalendarEventType = (typeof CALENDAR_EVENT_TYPE_VALUES)[number];

export function isCalendarEventType(v: unknown): v is CalendarEventType {
  return (
    typeof v === 'string' &&
    (CALENDAR_EVENT_TYPE_VALUES as readonly string[]).includes(v)
  );
}
