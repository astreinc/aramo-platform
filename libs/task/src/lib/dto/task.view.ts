import type { TaskOwnerType } from './task-owner-type.js';
import type { TaskPriority } from './task-priority.js';
import type { TaskSource } from './task-source.js';
import type { TaskStatus } from './task-status.js';
import type { TaskType } from './task-type.js';

// TaskView — read projection for a Task row.
//
// R10 invariant: identity + the to-do (title/description/due/status/type/
// priority/source/assignee/owner-link) ONLY. priority is an ordinal on a TASK
// (not a person) — R10-safe per the Workspace-Fields amendment.
export interface TaskView {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  status: TaskStatus;
  type: TaskType | null;
  priority: TaskPriority | null;
  source: TaskSource;
  assignee_id: string | null;
  created_by_user_id: string;
  owner_type: TaskOwnerType;
  owner_id: string;
  created_at: string;
  updated_at: string;
}
