import { ToastProvider } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { stubFetch, type StubCall } from '../tests/fetch-stub';

import { ATS_ROLES_HREF, RolesAccessPage } from './RolesAccessPage';
import { apiError, ATS_ONLY, CATALOG, PRODUCTS, session, user } from './users.fixture';

// ORG-UX-1 handoff §6.4 "Roles & access" / Directive §8.4, §13.2.

const ROSTER = [
  user('me', { display_name: 'Olive Owner', role_keys: ['tenant_owner'] }),
  user('ann', { display_name: 'Ann Active', role_keys: ['recruiter', 'sign_sender'] }),
  user('fay', { display_name: 'Fay Admin', role_keys: ['tenant_admin', 'recruiter'] }),
  user('sol', { display_name: 'Sol Single', role_keys: ['sign_viewer'] }),
  user('dan', { display_name: 'Dan Disabled', is_active: false, role_keys: ['recruiter'] }),
];

function setup(opts: { sub?: string; products?: typeof PRODUCTS; patch?: { status?: number; body?: unknown } } = {}) {
  const calls: StubCall[] = stubFetch(({ url, method }) => {
    if (method === 'GET' && url.startsWith('/v1/tenant/users')) return { body: { items: ROSTER } };
    if (url.startsWith('/v1/tenant/roles-catalog')) return { body: { roles: CATALOG } };
    if (method === 'PATCH') return opts.patch ?? { body: { membership_id: 'm' } };
    return undefined;
  });
  render(
    <ToastProvider>
      <RolesAccessPage session={session(opts.sub ?? 'me')} products={opts.products ?? PRODUCTS} />
    </ToastProvider>,
  );
  return calls;
}

const patches = (calls: StubCall[]) => calls.filter((c) => c.method === 'PATCH').map((c) => [c.url, c.body]);

describe('RolesAccessPage', () => {
  it('lists every tenant role by app with people counts (disabled excluded), filters by app', async () => {
    setup();
    const recruiter = await screen.findByTestId('role-row-recruiter');
    await waitFor(() => expect(within(recruiter).getByTestId('people-recruiter')).toHaveTextContent('2 people'));
    expect(within(recruiter).getByTestId('people-recruiter')).toHaveAttribute('title', 'Ann Active, Fay Admin');
    expect(within(recruiter).getByText('Aramo ATS')).toBeInTheDocument();
    expect(within(recruiter).getByText('Aramo default')).toBeInTheDocument();
    expect(within(recruiter).getByText('Permissions ↗')).toHaveAttribute('href', ATS_ROLES_HREF);
    expect(within(screen.getByTestId('role-row-sourcer')).getByText('No one')).toBeInTheDocument();
    expect(within(screen.getByTestId('role-row-tenant_owner')).queryByText('Permissions ↗')).toBeNull();
    const signPerms = within(screen.getByTestId('role-row-sign_sender')).getByText('Permissions ↗');
    expect(signPerms.getAttribute('href')).toBe(`https://sign.aramo.test/auth/sign/login?${new URLSearchParams({ return_to: '/sign/settings/members' }).toString()}`);
    expect(screen.queryByTestId('role-row-portal_principal_fixture')).toBeNull();
    expect(screen.getByText("Roles come from each app and can't be renamed here. Custom roles aren't available yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('seg-sign'));
    expect(screen.queryByTestId('role-row-recruiter')).toBeNull();
    expect(screen.getByTestId('role-row-sign_viewer')).toBeInTheDocument();
  });

  it('shows segments for subscribed apps only', async () => {
    setup({ products: ATS_ONLY });
    await screen.findByTestId('role-row-recruiter');
    expect(screen.getAllByRole('button', { pressed: false }).concat(screen.getAllByRole('button', { pressed: true })).map((b) => b.textContent).sort()).toEqual(['All apps', 'Aramo ATS', 'Organization']);
    expect(screen.queryByTestId('role-row-sign_sender')).toBeNull();
  });

  it('Manage people adds a person (whole set + role) and removes one (whole set − role)', async () => {
    const calls = setup();
    await screen.findByTestId('role-row-sourcer');
    fireEvent.click(screen.getByTestId('manage-sourcer'));
    expect(screen.getByTestId('manage-sourcer')).toHaveTextContent('Done');
    const open = screen.getByTestId('open-sourcer');
    const select = within(open).getByLabelText('Person to add');
    // Active people without the role; the disabled person is not offered.
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Olive Owner · me@acme.test', 'Ann Active · ann@acme.test', 'Fay Admin · fay@acme.test', 'Sol Single · sol@acme.test']);
    fireEvent.change(select, { target: { value: 'ann' } });
    fireEvent.click(within(open).getByText('Add to role'));
    await waitFor(() => expect(patches(calls)).toEqual([['/v1/tenant/users/ann/roles', { role_keys: ['recruiter', 'sign_sender', 'sourcer'] }]]));
    expect(await screen.findByText('Ann Active now has Sourcer.')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('manage-recruiter'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Fay Admin from Recruiter' }));
    await waitFor(() => expect(patches(calls)[1]).toEqual(['/v1/tenant/users/fay/roles', { role_keys: ['tenant_admin'] }]));
    expect(await screen.findByText('Fay Admin no longer has Recruiter.')).toBeInTheDocument();
  });

  it('blocks removing the last Tenant Owner, without a write', async () => {
    const calls = setup();
    await screen.findByTestId('role-row-tenant_owner');
    fireEvent.click(screen.getByTestId('manage-tenant_owner'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Olive Owner from Tenant Owner' }));
    expect(within(screen.getByTestId('open-tenant_owner')).getByRole('alert')).toHaveTextContent('An organization needs at least one Tenant Owner.');
    expect(patches(calls)).toHaveLength(0);
  });

  it('refuses to remove a person’s only role with the ≥1-role hint, without a write', async () => {
    const calls = setup();
    await screen.findByTestId('role-row-sign_viewer');
    fireEvent.click(screen.getByTestId('manage-sign_viewer'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sol Single from Sign Viewer' }));
    expect(within(screen.getByTestId('open-sign_viewer')).getByRole('alert')).toHaveTextContent(
      'Sol Single needs at least one role. To remove all access, disable the user in Users & invitations.',
    );
    expect(patches(calls)).toHaveLength(0);
  });

  it('a non-owner cannot change Tenant Owner holders', async () => {
    setup({ sub: 'fay' });
    await screen.findByTestId('role-row-tenant_owner');
    fireEvent.click(screen.getByTestId('manage-tenant_owner'));
    const open = screen.getByTestId('open-tenant_owner');
    expect(within(open).getByRole('button', { name: 'Remove Olive Owner from Tenant Owner' })).toBeDisabled();
    expect(within(open).getByText('Add to role')).toBeDisabled();
    expect(within(open).getByText('Only an owner can change owners.')).toBeInTheDocument();
  });

  it('maps a server 409 TENANT_LAST_OWNER refusal', async () => {
    setup({ patch: apiError(409, 'TENANT_LAST_OWNER') });
    await screen.findByTestId('role-row-tenant_owner');
    fireEvent.click(screen.getByTestId('manage-tenant_owner'));
    fireEvent.click(within(screen.getByTestId('open-tenant_owner')).getByText('Add to role'));
    expect(await within(screen.getByTestId('open-tenant_owner')).findByRole('alert')).toHaveTextContent('Your organization must keep at least one owner.');
  });
});
