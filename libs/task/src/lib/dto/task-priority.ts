// TaskPriority — the closed ordinal vocabulary (amendment v1.0 LOCKED).
// R10-safe: an ordinal on a TASK, not on a person — no portal-forbidden
// person-ranking. Plain String + guard (NO Prisma enum). Nullable on the
// entity. Out-of-vocab → 400 VALIDATION_ERROR + details.field='priority'.
export const TASK_PRIORITY_VALUES = ['high', 'med', 'low'] as const;

export type TaskPriority = (typeof TASK_PRIORITY_VALUES)[number];

export function isTaskPriority(value: unknown): value is TaskPriority {
  return (
    typeof value === 'string' &&
    (TASK_PRIORITY_VALUES as readonly string[]).includes(value)
  );
}
