// TaskType — the closed vocabulary of task kinds (amendment v1.0 LOCKED).
// Plain String + guard (NO Prisma enum) — the Talent stated-fields precedent.
// Nullable on the entity: an untyped task is valid. The repo/controller reject
// an out-of-vocab value with 400 VALIDATION_ERROR + details.field='type'.
export const TASK_TYPE_VALUES = [
  'call',
  'email',
  'follow_up',
  'interview',
  'screen',
  'consent',
  'admin',
] as const;

export type TaskType = (typeof TASK_TYPE_VALUES)[number];

export function isTaskType(value: unknown): value is TaskType {
  return (
    typeof value === 'string' &&
    (TASK_TYPE_VALUES as readonly string[]).includes(value)
  );
}
