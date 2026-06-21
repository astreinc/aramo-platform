import { apiClient } from '@aramo/fe-foundation';

import type {
  CreateTaskRequest,
  TaskListResponse,
  TaskOwnerType,
  TaskStatus,
  TaskView,
  UpdateTaskRequest,
} from './types';

// Tasks FE — the consumer of the Tasks backend. The list endpoints AND the
// linked-entity visibility server-side (the 4-resolver backend). The Tasks
// workspace fetches the assignee's full set once (status='all') and computes
// its views/groups/summary/filters CLIENT-SIDE (the mockup's model) — the data
// is real; only the view arithmetic is local. The BE additionally supports
// server-side ?status/?type/?priority filters (the indexed columns).

// GET /v1/tasks (my-tasks — assignee=actor, due-sorted; my-tasks defaults to
// the ACTIVE status set, 'all' returns every lifecycle state).
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

// §5 Auth-Hardening D4c — the admin-gated probeTenantUsers roster is RETIRED.
// The task assignee picker sources fetchAssignableUsers (users/users-api); name
// resolution sources resolveUserNames (the directory). No probe here anymore.
