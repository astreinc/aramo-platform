import type { TaskPriority } from './task-priority.js';
import type { TaskStatus } from './task-status.js';
import type { TaskType } from './task-type.js';

// PATCH /v1/tasks/:id body (Ruling R6 — owner IMMUTABLE; status/assignee/
// title/description/due_date/type/priority mutable). TRUE PATCH: omitted →
// unchanged; explicit null clears the nullable fields. owner_type/owner_id are
// absent by construction (a task does not migrate entities). A reassigned
// assignee_id is re-validated (active within-tenant). type/priority are
// closed-set-guarded at the controller. `source` is system-owned — not mutable.
export interface UpdateTaskRequestDto {
  title?: string;
  description?: string | null;
  due_date?: string | null;
  status?: TaskStatus;
  assignee_id?: string | null;
  type?: TaskType | null;
  priority?: TaskPriority | null;
}
