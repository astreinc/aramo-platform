import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SenderContext } from '../api';
import { customRolesVisible, type CustomRoleList, type CustomRoleMember } from '../custom-roles-api';

// Aramo Sign Feature-Parity §1.21 — Administration → Roles. Hidden unless the capability is
// available and the caller manages members; permissions the administrator lacks cannot be
// granted; a role in use cannot be deleted; members get or lose roles by checkbox.

const list = vi.fn();
const members = vi.fn();
const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const assign = vi.fn();
const unassign = vi.fn();
vi.mock('../custom-roles-api', async (orig) => {
  const mod = await orig<typeof import('../custom-roles-api')>();
  return {
    ...mod,
    customRolesApi: {
      list: (...a: unknown[]) => list(...a),
      members: (...a: unknown[]) => members(...a),
      create: (...a: unknown[]) => create(...a),
      update: (...a: unknown[]) => update(...a),
      remove: (...a: unknown[]) => remove(...a),
      assign: (...a: unknown[]) => assign(...a),
      unassign: (...a: unknown[]) => unassign(...a),
    },
  };
});
const toast = vi.fn();
let ctx: SenderContext;
vi.mock('../workspace', () => ({ useWorkspace: () => ({ base: '/sign', toast, ctx }) }));

import { CustomRolesPage } from './CustomRoles';

const BASE_CTX: SenderContext = {
  user: { id: 'u1', email: 'a@org.test', display_name: 'Ada' },
  tenant: { id: 't1', name: 'Org', kind: 'BUSINESS' },
  workspace: 'sign',
  permissions: { read: true, create: true, send: true, members: true },
  features: { custom_roles: true } as SenderContext['features'],
  can_send: true,
  personal_sending_enabled: false,
  organization_url: null,
  app_home_url: null,
};

const LIST: CustomRoleList = {
  permissions: [
    { key: 'sign:envelope:read', grantable: true },
    { key: 'sign:envelope:send', grantable: true },
    { key: 'sign:envelope:manage:all', grantable: false },
  ],
  roles: [
    { id: 'r1', name: 'Desk', description: 'Front desk', scope_keys: ['sign:envelope:read'], member_count: 1, created_at: '', updated_at: '' },
    { id: 'r2', name: 'Managers', description: null, scope_keys: ['sign:envelope:manage:all'], member_count: 0, created_at: '', updated_at: '' },
  ],
};
const MEMBERS: CustomRoleMember[] = [
  { user_id: 'm1', email: 'm1@org.test', display_name: 'Max', role_keys: ['sign_sender'], custom_role_ids: ['r1'] },
  { user_id: 'm2', email: 'm2@org.test', display_name: null, role_keys: [], custom_role_ids: [] },
];

function show() {
  render(
    <MemoryRouter>
      <CustomRolesPage />
    </MemoryRouter>,
  );
}

afterEach(() => vi.clearAllMocks());

describe('Roles page', () => {
  it('is visible only for a BUSINESS workspace with the capability and member management', () => {
    expect(customRolesVisible(BASE_CTX)).toBe(true);
    expect(customRolesVisible({ ...BASE_CTX, features: {} })).toBe(false);
    expect(customRolesVisible({ ...BASE_CTX, features: undefined })).toBe(false);
    expect(customRolesVisible({ ...BASE_CTX, permissions: { ...BASE_CTX.permissions, members: false } })).toBe(false);
    expect(customRolesVisible({ ...BASE_CTX, workspace: 'personal' })).toBe(false);
  });

  it('shows the unavailable state and calls nothing when the capability is off', () => {
    ctx = { ...BASE_CTX, features: {} };
    show();
    expect(screen.getByText('Custom roles aren’t available')).toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
  });

  it('lists roles and members; a role the admin cannot fully grant cannot be edited, deleted or assigned; a role in use cannot be deleted', async () => {
    ctx = BASE_CTX;
    list.mockResolvedValue(LIST);
    members.mockResolvedValue({ members: MEMBERS });
    show();
    expect(await screen.findByTestId('custom-role-r1')).toHaveTextContent('Desk');
    expect(screen.getByTestId('custom-role-r1')).toHaveTextContent('View own envelopes — 1 member');
    expect(screen.getByTestId('custom-role-delete-r1')).toBeDisabled();
    expect(screen.getByTestId('custom-role-delete-r2')).toBeDisabled();
    expect(screen.getByLabelText('Managers for Max')).toBeDisabled();
    expect(screen.getByLabelText('Desk for Max')).toBeChecked();
    expect(screen.getByText('Sign Sender')).toBeInTheDocument();
  });

  it('creates a role only from grantable permissions', async () => {
    ctx = BASE_CTX;
    list.mockResolvedValue(LIST);
    members.mockResolvedValue({ members: MEMBERS });
    create.mockResolvedValue({ role: LIST.roles[0] });
    show();
    fireEvent.click(await screen.findByTestId('custom-role-new'));
    expect(screen.getByTestId('cr-perm-sign:envelope:manage:all')).toBeDisabled();
    expect(screen.getByTestId('custom-role-save')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Senders ' } });
    fireEvent.click(screen.getByTestId('cr-perm-sign:envelope:read'));
    fireEvent.click(screen.getByTestId('cr-perm-sign:envelope:send'));
    fireEvent.click(screen.getByTestId('custom-role-save'));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: 'Senders', description: null, scope_keys: ['sign:envelope:read', 'sign:envelope:send'] }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Role created'));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('gives and removes a role by checkbox and shows a backend refusal', async () => {
    ctx = BASE_CTX;
    list.mockResolvedValue(LIST);
    members.mockResolvedValue({ members: MEMBERS });
    unassign.mockResolvedValue({ unassigned: true });
    assign.mockRejectedValue(new Error('nope'));
    show();
    fireEvent.click(await screen.findByLabelText('Desk for Max'));
    await waitFor(() => expect(unassign).toHaveBeenCalledWith('r1', 'm1'));
    fireEvent.click(await screen.findByLabelText('Desk for m2@org.test'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('r1', 'm2'));
    expect(await screen.findByText('Something went wrong. Try again.')).toBeInTheDocument();
  });
});
