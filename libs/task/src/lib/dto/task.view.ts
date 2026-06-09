import type { TaskOwnerType } from './task-owner-type.js';
import type { TaskStatus } from './task-status.js';

// TaskView — read projection for a Task row.
//
// R10 invariant: identity + the to-do (title/description/due/status/assignee/
// owner-link) ONLY — NO portal-forbidden numeric/ordinal field.
export interface TaskView {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  status: TaskStatus;
  assignee_id: string | null;
  created_by_user_id: string;
  owner_type: TaskOwnerType;
  owner_id: string;
  created_at: string;
  updated_at: string;
}
