// TaskSource — provenance closed set (amendment v1.0 LOCKED). Default 'manual'.
// 'auto' is RESERVED — never written by any v1 write path (the eventing
// substrate that would generate auto-tasks is deferred); the UI exposes it only
// as a disabled "coming with Aramo Core" seam. Plain String + guard.
export const TASK_SOURCE_VALUES = ['manual', 'auto'] as const;

export type TaskSource = (typeof TASK_SOURCE_VALUES)[number];

export function isTaskSource(value: unknown): value is TaskSource {
  return (
    typeof value === 'string' &&
    (TASK_SOURCE_VALUES as readonly string[]).includes(value)
  );
}
