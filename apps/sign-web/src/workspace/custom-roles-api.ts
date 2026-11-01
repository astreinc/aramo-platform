import { apiClient } from '@aramo/fe-foundation';

import type { SenderContext } from './api';

// Aramo Sign Feature-Parity §1.21 — typed client for the custom-roles routes
// (/v1/sign/sender/custom-roles). The backend decides availability, plan entitlement, the
// caller's authority (sign:member:manage) and every anti-escalation rule; this module only
// carries requests.

const BASE = '/v1/sign/sender/custom-roles';
const enc = encodeURIComponent;

export interface CustomRole {
  id: string;
  name: string;
  description: string | null;
  scope_keys: string[];
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface CustomRolePermission {
  key: string;
  grantable: boolean;
}

export interface CustomRoleList {
  permissions: CustomRolePermission[];
  roles: CustomRole[];
}

export interface CustomRoleMember {
  user_id: string;
  email: string | null;
  display_name: string | null;
  role_keys: string[];
  custom_role_ids: string[];
}

export interface CustomRoleInput {
  name: string;
  description: string | null;
  scope_keys: string[];
}

export const customRolesApi = {
  list: () => apiClient.get<CustomRoleList>(BASE),
  members: () => apiClient.get<{ members: CustomRoleMember[] }>(`${BASE}/members`),
  create: (input: CustomRoleInput) => apiClient.post<{ role: CustomRole }>(BASE, input),
  update: (id: string, input: Partial<CustomRoleInput>) => apiClient.patch<{ role: CustomRole }>(`${BASE}/${enc(id)}`, input),
  remove: (id: string) => apiClient.delete<{ deleted: boolean }>(`${BASE}/${enc(id)}`),
  assign: (id: string, userId: string) => apiClient.put<{ assigned: boolean }>(`${BASE}/${enc(id)}/members/${enc(userId)}`, {}),
  unassign: (id: string, userId: string) => apiClient.delete<{ unassigned: boolean }>(`${BASE}/${enc(id)}/members/${enc(userId)}`),
};

// The Sign permissions in plain words (the keys stay the contract).
export const PERMISSION_LABELS: Readonly<Record<string, { label: string; help: string }>> = {
  'sign:envelope:read': { label: 'View own envelopes', help: 'See and track envelopes they sent.' },
  'sign:envelope:read:all': { label: 'View all envelopes', help: 'See every envelope in the organization.' },
  'sign:envelope:create': { label: 'Prepare envelopes', help: 'Upload documents, add recipients and fields.' },
  'sign:envelope:send': { label: 'Send envelopes', help: 'Send, remind and void their own envelopes.' },
  'sign:envelope:manage:all': { label: 'Manage all envelopes', help: 'Change, remind or void any envelope in the organization.' },
  'sign:contact:read': { label: 'Use contacts', help: 'Pick recipients from the organization’s contacts.' },
  'sign:report:read': { label: 'View reports', help: 'Open the organization’s Sign reports.' },
  'sign:member:manage': { label: 'Manage roles', help: 'Create custom roles and give roles to members.' },
  'sign:settings:manage': { label: 'Manage settings', help: 'Change organization Sign settings such as retention.' },
  'sign:integration:manage': { label: 'Manage integrations', help: 'Connect and manage apps that use Aramo Sign.' },
};

export function permissionLabel(key: string): string {
  return PERMISSION_LABELS[key]?.label ?? key;
}

// Built-in roles as members see them (read-only on this page).
export const BUILT_IN_ROLE_LABELS: Readonly<Record<string, string>> = {
  tenant_owner: 'Tenant Owner',
  tenant_admin: 'Tenant Admin',
  sign_admin: 'Sign Admin',
  sign_sender: 'Sign Sender',
  sign_viewer: 'Sign Viewer',
};

/** The Roles page is offered only when the capability is available and the caller manages members. */
export function customRolesVisible(ctx: SenderContext): boolean {
  const features = (ctx.features ?? {}) as { custom_roles?: boolean };
  return ctx.workspace === 'sign' && features.custom_roles === true && ctx.permissions.members === true;
}
