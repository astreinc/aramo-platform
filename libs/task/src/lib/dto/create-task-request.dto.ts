import type { TaskOwnerType } from './task-owner-type.js';
import type { TaskPriority } from './task-priority.js';
import type { TaskType } from './task-type.js';

// POST /v1/tasks body. owner_type + owner_id + title required; the owner must
// be VISIBLE to the actor at create (the create-time assert → 404 if not).
// assignee_id (optional) must resolve to an active within-tenant identity.User.
// type/priority (optional) are closed-set-guarded at the controller (400 on a
// bad value). `source` is NOT accepted — every created task is 'manual' (the
// 'auto' value is reserved for the deferred eventing substrate).
export interface CreateTaskRequestDto {
  title: string;
  owner_type: TaskOwnerType;
  owner_id: string;
  description?: string;
  due_date?: string;
  assignee_id?: string;
  type?: TaskType;
  priority?: TaskPriority;
  // CRM-6 (§10, PO ruling) — OPTIONAL contextual requisition association. Not
  // ownership; validated server-side (same-tenant, visible, and for a Talent
  // owner a real Talent↔Requisition pipeline relationship).
  requisition_id?: string;
}
