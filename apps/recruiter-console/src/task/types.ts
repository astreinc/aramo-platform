// Hand-mirrored from libs/task/src/lib/dto/{task.view,task-owner-type,
// task-status,create-task-request.dto,update-task-request.dto}.ts +
// libs/identity TenantUserView (the roster). Source-annotated so a BE shape
// change is caught by the failing build (the missing field), not silent
// drift. Hand-mirror instead of importing @aramo/task / @aramo/identity (a
// forbidden domain edge from apps/recruiter-console). Flat field lists — no
// drift spec (rule of three; mirror-of-logic-only).

export const TASK_OWNER_TYPE_VALUES = [
  'talent_record',
  'requisition',
  'company',
  'contact',
] as const;
export type TaskOwnerType = (typeof TASK_OWNER_TYPE_VALUES)[number];

export const TASK_STATUS_VALUES = ['open', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

export interface TaskView {
  readonly id: string;
  readonly tenant_id: string;
  readonly title: string;
  readonly description: string | null;
  readonly due_date: string | null;
  readonly status: TaskStatus;
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
// (immutable after create; the BE rejects owner changes on PATCH).
export interface CreateTaskRequest {
  readonly title: string;
  readonly owner_type: TaskOwnerType;
  readonly owner_id: string;
  readonly description?: string;
  readonly due_date?: string;
  readonly assignee_id?: string;
}

// PATCH /v1/tasks/:id — status/assignee/title/description/due_date mutable;
// owner is NOT a field (immutable). null clears the nullable fields.
export interface UpdateTaskRequest {
  readonly title?: string;
  readonly description?: string | null;
  readonly due_date?: string | null;
  readonly status?: TaskStatus;
  readonly assignee_id?: string | null;
}

// Minimal hand-mirror of libs/identity TenantUserView — only what the
// assignee Combobox needs. The roster (GET /v1/tenant/users) is ADMIN-gated
// (tenant:admin:user-manage); a non-admin task-writer gets a graceful
// fallback (the S5c probe precedent).
export interface TenantUserRosterEntry {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly is_active: boolean;
}

export interface TenantUserRosterResponse {
  readonly items: readonly TenantUserRosterEntry[];
}
