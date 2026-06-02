// ActivityType — closed list of activity kinds (mirrors the Prisma enum).
// `pipeline_status_change` is the system-written kind emitted inside the
// pipeline transition transaction; the rest are manual recruiter entries.
export const ACTIVITY_TYPE_VALUES = [
  'pipeline_status_change',
  'note',
  'call',
  'email_logged',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPE_VALUES)[number];

export function isActivityType(value: unknown): value is ActivityType {
  return (
    typeof value === 'string' &&
    (ACTIVITY_TYPE_VALUES as readonly string[]).includes(value)
  );
}
