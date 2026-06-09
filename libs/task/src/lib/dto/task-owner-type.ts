// TaskOwnerType — the closed list of entity-link targets for a task.
// Mirrors the Attachment/Activity polymorphic-owner discriminator. The 4
// targets each compose their own read visibility (talent_record pool-open;
// requisition/company/contact via the libs/visibility resolver reuse).
export const TASK_OWNER_TYPE_VALUES = [
  'talent_record',
  'requisition',
  'company',
  'contact',
] as const;

export type TaskOwnerType = (typeof TASK_OWNER_TYPE_VALUES)[number];

export function isTaskOwnerType(value: unknown): value is TaskOwnerType {
  return (
    typeof value === 'string' &&
    (TASK_OWNER_TYPE_VALUES as readonly string[]).includes(value)
  );
}
