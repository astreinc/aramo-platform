import { ApiError, apiClient } from '@aramo/fe-foundation';

import type {
  CreateTaskRequest,
  TaskListResponse,
  TaskOwnerType,
  TaskStatus,
  TaskView,
  TenantUserRosterEntry,
  TenantUserRosterResponse,
  UpdateTaskRequest,
} from './types';

// Tasks FE — the consumer of the Tasks backend (PR d9af697). The list
// endpoints AND the linked-entity visibility server-side (the 4-resolver
// backend); the FE renders what arrives — NO client-side filtering.

// GET /v1/tasks (my-tasks — assignee=actor, due-sorted, default status open).
// `assignee_id=me` is the backend's self-list default; we pass it explicitly.
export async function listMyTasks(
  status?: TaskStatus | 'all',
): Promise<TaskListResponse> {
  const params = new URLSearchParams({ assignee_id: 'me' });
  if (status !== undefined) params.set('status', status);
  return apiClient.get<TaskListResponse>(`/v1/tasks?${params.toString()}`);
}

// GET /v1/tasks?owner_type&owner_id (by-entity — the per-entity Tasks tab).
export async function listTasksForOwner(
  ownerType: TaskOwnerType,
  ownerId: string,
  status?: TaskStatus | 'all',
): Promise<TaskListResponse> {
  const params = new URLSearchParams({
    owner_type: ownerType,
    owner_id: ownerId,
  });
  if (status !== undefined) params.set('status', status);
  return apiClient.get<TaskListResponse>(`/v1/tasks?${params.toString()}`);
}

export async function createTask(body: CreateTaskRequest): Promise<TaskView> {
  return apiClient.post<TaskView>('/v1/tasks', body);
}

export async function updateTask(
  id: string,
  body: UpdateTaskRequest,
): Promise<TaskView> {
  return apiClient.patch<TaskView>(`/v1/tasks/${id}`, body);
}

export async function deleteTask(id: string): Promise<void> {
  await apiClient.delete<void>(`/v1/tasks/${id}`);
}

export interface RosterState {
  readonly available: boolean;
  readonly items: readonly TenantUserRosterEntry[];
}

// Probe the tenant-users roster for the assignee Combobox (the S5c
// probeUserRoster precedent). GET /v1/tenant/users is ADMIN-gated
// (tenant:admin:user-manage) — a non-admin task-writer 403s; we fall back
// gracefully (available=false → the dialog offers no picker, the task is
// created unassigned). Only ACTIVE members are assignable (the BE rejects
// inactive with 422 anyway).
export async function probeTenantUsers(): Promise<RosterState> {
  try {
    const res = await apiClient.get<TenantUserRosterResponse>('/v1/tenant/users');
    return {
      available: true,
      items: res.items.filter((u) => u.is_active),
    };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
      return { available: false, items: [] };
    }
    throw err;
  }
}
