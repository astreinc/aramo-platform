import type { TaskOwnerType } from './task-owner-type.js';

// POST /v1/tasks body. owner_type + owner_id + title required; the owner must
// be VISIBLE to the actor at create (the create-time assert → 404 if not).
// assignee_id (optional) must resolve to an active within-tenant identity.User.
export interface CreateTaskRequestDto {
  title: string;
  owner_type: TaskOwnerType;
  owner_id: string;
  description?: string;
  due_date?: string;
  assignee_id?: string;
}
