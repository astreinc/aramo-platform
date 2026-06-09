// TaskStatus — the binary to-do lifecycle (Ruling R2). Mirrors the Prisma
// enum. `in_progress` is a deliberate follow-on (not v1).
export const TASK_STATUS_VALUES = ['open', 'done'] as const;

export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === 'string' &&
    (TASK_STATUS_VALUES as readonly string[]).includes(value)
  );
}
