// Hand-mirrored from libs/task/src/lib/dto/{task.view,task-owner-type,
// task-status,task-type,task-priority,task-source,create-task-request.dto,
// update-task-request.dto}.ts + libs/identity TenantUserView (the roster).
// Source-annotated so a BE shape change is caught by the failing build (the
// missing field), not silent drift. Hand-mirror instead of importing
// @aramo/task / @aramo/identity (a forbidden domain edge from
// apps/ats-web). The four closed-set vocab arrays below mirror the BE
// guards 1:1 and are pinned by task-vocab-drift.spec.ts (rule of three reached:
// type/priority/status/source are all guarded closed sets).

export const TASK_OWNER_TYPE_VALUES = [
  'talent_record',
  'requisition',
  'company',
  'contact',
] as const;
export type TaskOwnerType = (typeof TASK_OWNER_TYPE_VALUES)[number];

// Workspace-Fields amendment v1.0 LOCKED — the lifecycle widened from the
// original binary {open,done}. ACTIVE = open/in_progress/waiting; TERMINAL =
// done/cancelled.
export const TASK_STATUS_VALUES = [
  'open',
  'in_progress',
  'waiting',
  'done',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

export const TASK_ACTIVE_STATUS_VALUES = [
  'open',
  'in_progress',
  'waiting',
] as const;

export const TASK_TYPE_VALUES = [
  'call',
  'email',
  'follow_up',
  'interview',
  'screen',
  'consent',
  'admin',
] as const;
export type TaskType = (typeof TASK_TYPE_VALUES)[number];

export const TASK_PRIORITY_VALUES = ['high', 'med', 'low'] as const;
export type TaskPriority = (typeof TASK_PRIORITY_VALUES)[number];

export const TASK_SOURCE_VALUES = ['manual', 'auto'] as const;
export type TaskSource = (typeof TASK_SOURCE_VALUES)[number];

export interface TaskView {
  readonly id: string;
  readonly tenant_id: string;
  readonly title: string;
  readonly description: string | null;
  readonly due_date: string | null;
  readonly status: TaskStatus;
  readonly type: TaskType | null;
  readonly priority: TaskPriority | null;
  readonly source: TaskSource;
  readonly assignee_id: string | null;
  readonly created_by_user_id: string;
  readonly owner_type: TaskOwnerType;
  readonly owner_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TaskListResponse {
  readonly items: readonly TaskView[];
}

// POST /v1/tasks — owner_type/owner_id set from the in-context entity
// (immutable after create; the BE rejects owner changes on PATCH). type/
// priority optional, closed-set-guarded by the BE. `source` is system-owned
// (every created task is 'manual').
export interface CreateTaskRequest {
  readonly title: string;
  readonly owner_type: TaskOwnerType;
  readonly owner_id: string;
  readonly description?: string;
  readonly due_date?: string;
  readonly assignee_id?: string;
  readonly type?: TaskType;
  readonly priority?: TaskPriority;
}

// PATCH /v1/tasks/:id — status/assignee/title/description/due_date/type/
// priority mutable; owner is NOT a field (immutable). null clears the nullable
// fields.
export interface UpdateTaskRequest {
  readonly title?: string;
  readonly description?: string | null;
  readonly due_date?: string | null;
  readonly status?: TaskStatus;
  readonly assignee_id?: string | null;
  readonly type?: TaskType | null;
  readonly priority?: TaskPriority | null;
}
