// TaskStatus — the to-do lifecycle (amendment v1.0 LOCKED, widened from the
// original binary {open,done}). Mirrors the Prisma enum 1:1. ACTIVE =
// open/in_progress/waiting; TERMINAL = done/cancelled.
export const TASK_STATUS_VALUES = [
  'open',
  'in_progress',
  'waiting',
  'done',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

// The active (non-terminal) subset — used by the my-tasks default filter.
export const TASK_ACTIVE_STATUS_VALUES = [
  'open',
  'in_progress',
  'waiting',
] as const;

export function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === 'string' &&
    (TASK_STATUS_VALUES as readonly string[]).includes(value)
  );
}
