import type { TaskStatus } from './task-status.js';

// PATCH /v1/tasks/:id body (Ruling R6 — owner IMMUTABLE; status/assignee/
// title/description/due_date mutable). TRUE PATCH: omitted → unchanged;
// explicit null clears the nullable fields. owner_type/owner_id are absent
// by construction (a task does not migrate entities). A reassigned
// assignee_id is re-validated (active within-tenant).
export interface UpdateTaskRequestDto {
  title?: string;
  description?: string | null;
  due_date?: string | null;
  status?: TaskStatus;
  assignee_id?: string | null;
}
