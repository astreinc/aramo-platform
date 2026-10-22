import { ToastProvider } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { stubFetch } from '../tests/fetch-stub';

import { EditAccessModal } from './EditAccessModal';
import { InviteUserModal } from './InviteUserModal';
import { buildRoleGroups, groupOfRole, splitUserRoles, subscribedApps } from './role-groups';
import { apiError, ATS_ONLY, CATALOG, PRODUCTS, user } from './users.fixture';

// ORG-UX-1 handoff §6.3/§6.4, Directive §4.4 (H4) — Edit access + Invite user + role groups.

const GROUPS = buildRoleGroups(CATALOG, subscribedApps(PRODUCTS));

function renderEdit(opts: { owner: boolean; roleKeys?: string[]; onSaved?: () => void }) {
  return render(
    <ToastProvider>
      <EditAccessModal
        user={user('ann', { display_name: 'Ann Active', role_keys: opts.roleKeys ?? ['recruiter'] })}
        groups={GROUPS}
        callerIsOwner={opts.owner}
        onOpenChange={() => undefined}
        onSaved={opts.onSaved ?? (() => undefined)}
      />
    </ToastProvider>,
  );
}

describe('role groups', () => {
  it('splits Organization / ATS / Sign by key and drops the portal tier', () => {
    expect(GROUPS.map((g) => [g.key, g.roles.map((r) => r.key)])).toEqual([
      ['org', ['tenant_owner', 'tenant_admin']],
      ['ats', ['ats_admin', 'recruiter', 'sourcer']],
      ['sign', ['sign_sender', 'sign_viewer']],
    ]);
    expect(groupOfRole({ key: 'portal_principal_fixture', tier: 'Portal' })).toBeNull();
    expect(buildRoleGroups(CATALOG, subscribedApps(ATS_ONLY)).map((g) => g.key)).toEqual(['org', 'ats']);
    expect(splitUserRoles(['tenant_owner', 'sign_viewer', 'recruiter'], CATALOG)).toEqual({ org: ['Tenant Owner'], ats: ['Recruiter'], sign: ['Sign Viewer'] });
  });
});

describe('EditAccessModal', () => {
  it('groups one per subscribed app plus Organization, with notes', () => {
    renderEdit({ owner: true });
    const modal = screen.getByTestId('edit-access-modal');
    expect(within(modal).getByText('Organization')).toBeInTheDocument();
    expect(within(modal).getByText('No role means Member')).toBeInTheDocument();
    expect(within(modal).getAllByText('App roles')).toHaveLength(2);
    expect(within(modal).getByText(/To remove all access, disable the user in Users & invitations\./)).toBeInTheDocument();
  });

  it('a non-owner sees the Tenant Owner checkbox disabled with the hint; an owner can tick it', () => {
    const { unmount } = renderEdit({ owner: false });
    expect(screen.getByRole('checkbox', { name: 'Tenant Owner' })).toBeDisabled();
    expect(screen.getByText('Only an owner can change owners.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Tenant Admin' })).toBeEnabled();
    unmount();
    renderEdit({ owner: true });
    const owner = screen.getByRole('checkbox', { name: 'Tenant Owner' });
    expect(owner).toBeEnabled();
    fireEvent.click(owner);
    expect(owner).toHaveAttribute('aria-checked', 'true');
  });

  it('Save access is disabled when nothing is ticked', () => {
    renderEdit({ owner: true });
    const save = screen.getByTestId('save-access');
    expect(save).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Recruiter' }));
    expect(save).toBeDisabled();
  });

  it('saves the whole role set via PATCH roles', async () => {
    const calls = stubFetch(({ method }) => (method === 'PATCH' ? { body: { membership_id: 'm' } } : undefined));
    const onSaved = vi.fn();
    renderEdit({ owner: true, onSaved });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sign Sender' }));
    fireEvent.click(screen.getByTestId('save-access'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toBe('/v1/tenant/users/ann/roles');
    expect(patch?.body).toEqual({ role_keys: ['recruiter', 'sign_sender'] });
  });

  it('maps 409 TENANT_LAST_OWNER to the directive copy', async () => {
    stubFetch(({ method }) => (method === 'PATCH' ? apiError(409, 'TENANT_LAST_OWNER') : undefined));
    renderEdit({ owner: true, roleKeys: ['tenant_owner', 'recruiter'] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tenant Owner' }));
    fireEvent.click(screen.getByTestId('save-access'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your organization must keep at least one owner.');
  });
});

describe('InviteUserModal', () => {
  function renderInvite(onInvited = vi.fn()) {
    const calls = stubFetch(({ url, method }) => {
      if (url.startsWith('/v1/tenant/roles-catalog')) return { body: { roles: CATALOG } };
      if (url.startsWith('/v1/me/products')) return { body: PRODUCTS };
      if (method === 'GET' && url.startsWith('/v1/tenant/users')) return { body: { items: [user('o', { email: 'o@acme.test', role_keys: ['tenant_admin'] })] } };
      if (method === 'POST' && url.endsWith('/invitations')) return { body: { user_id: 'n', membership_id: 'm', invite_status: 'INVITED', invitation_id: 'i' } };
      return undefined;
    });
    render(
      <ToastProvider>
        <InviteUserModal open onOpenChange={() => undefined} onInvited={onInvited} />
      </ToastProvider>,
    );
    return calls;
  }

  it('loads groups itself, preselects nothing, needs a role, validates the email', async () => {
    const onInvited = vi.fn();
    const calls = renderInvite(onInvited);
    expect(screen.getByText('They get an email invitation and sign in with their work account. Aramo never creates passwords.')).toBeInTheDocument();
    const recruiter = await screen.findByRole('checkbox', { name: 'Recruiter' });
    expect(screen.getAllByRole('checkbox').every((c) => c.getAttribute('aria-checked') === 'false')).toBe(true);
    // The caller (o@acme.test, from the /v1/me stub) is not an owner.
    expect(screen.getByRole('checkbox', { name: 'Tenant Owner' })).toBeDisabled();
    expect(screen.getByTestId('send-invitation')).toBeDisabled();
    fireEvent.click(recruiter);
    fireEvent.change(screen.getByTestId('invite-email'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByTestId('send-invitation'));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a work email address.');
    fireEvent.change(screen.getByTestId('invite-email'), { target: { value: 'O@acme.test' } });
    fireEvent.click(screen.getByTestId('send-invitation'));
    expect(screen.getByRole('alert')).toHaveTextContent('This person is already in your organization.');
    fireEvent.change(screen.getByTestId('invite-email'), { target: { value: 'new@acme.test' } });
    fireEvent.change(screen.getByTestId('invite-name'), { target: { value: 'New Person' } });
    fireEvent.click(screen.getByTestId('send-invitation'));
    await waitFor(() => expect(onInvited).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ email: 'new@acme.test', display_name: 'New Person', role_keys: ['recruiter'] });
    expect(await screen.findByText('Invitation sent to new@acme.test.')).toBeInTheDocument();
  });
});
