import { ToastProvider } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { stubFetch, type StubCall } from '../tests/fetch-stub';

import { UsersInvitationsPage } from './UsersInvitationsPage';
import { ATS_ONLY, CATALOG, PRODUCTS, session, user } from './users.fixture';

// ORG-UX-1 handoff §6.3 / Directive §8.3, §13.1 — Users & invitations.

const ROSTER = [
  user('me', { display_name: 'Olive Owner', role_keys: ['recruiter', 'tenant_owner'] }),
  user('ann', { display_name: 'Ann Active', role_keys: ['recruiter', 'sign_sender', 'sourcer'] }),
  user('fay', { display_name: 'Fay Admin', role_keys: ['tenant_admin'] }),
  user('bob', { display_name: 'Bob Invited', invite_status: 'INVITED', invited_at: '2026-10-18T10:00:00.000Z' }),
  user('cat', { display_name: 'Cat Accepted', invite_status: 'ACCEPTED', invited_at: '2026-10-17T10:00:00.000Z' }),
  user('dan', { display_name: 'Dan Disabled', is_active: false, deactivated_at: '2026-10-01T00:00:00.000Z' }),
  user('eve', { display_name: 'Eve Failed', invite_status: 'FAILED', role_keys: ['sign_viewer'] }),
];

function setup(products = PRODUCTS) {
  const calls: StubCall[] = stubFetch(({ url, method }) => {
    if (method === 'GET' && url.startsWith('/v1/tenant/users')) return { body: { items: ROSTER } };
    if (url.startsWith('/v1/tenant/roles-catalog')) return { body: { roles: CATALOG } };
    return undefined;
  });
  render(
    <ToastProvider>
      <UsersInvitationsPage session={session('me')} products={products} />
    </ToastProvider>,
  );
  return calls;
}

const tabCount = (key: string) => within(screen.getByTestId(`tab-${key}`)).getByText(/\d+/).textContent;
const posts = (calls: StubCall[], suffix: string) => calls.filter((c) => c.method === 'POST' && c.url.endsWith(suffix)).map((c) => c.url.split('/')[4]);

describe('UsersInvitationsPage', () => {
  it('shows the five lifecycle tabs (H9) with counts and distinguishable pills', async () => {
    setup();
    await screen.findByText('Olive Owner');
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual(['All', 'Invited', 'Accepted', 'Active', 'Disabled', 'Failed']);
    expect([tabCount('all'), tabCount('INVITED'), tabCount('ACCEPTED'), tabCount('ACTIVE'), tabCount('INACTIVE'), tabCount('FAILED')]).toEqual(['7', '1', '1', '3', '1', '1']);
    expect(screen.getByTestId('status-bob')).toHaveTextContent('Invited');
    expect(screen.getByTestId('status-bob')).toHaveClass('ox-pill--invited');
    expect(screen.getByTestId('status-cat')).toHaveTextContent('Accepted');
    expect(screen.getByTestId('status-cat')).toHaveClass('ox-pill--invited');
    expect(screen.getByTestId('status-dan')).toHaveClass('ox-pill--disabled');
    expect(screen.getByTestId('status-eve')).toHaveClass('ox-pill--failed');
    expect(screen.getByTestId('status-ann')).toHaveClass('ox-pill--active');
    fireEvent.click(screen.getByTestId('tab-FAILED'));
    expect(screen.getByText('Eve Failed')).toBeInTheDocument();
    expect(screen.queryByText('Ann Active')).toBeNull();
  });

  it('renders Organization, App access chips, last sign-in and per-state actions', async () => {
    setup();
    const ann = await screen.findByTestId('user-row-ann');
    expect(within(ann).getByText('Member')).toBeInTheDocument();
    expect(within(ann).getByText('ATS · Recruiter +1')).toHaveAttribute('title', 'ATS: Recruiter, Sourcer');
    expect(within(ann).getByText('Sign · Sender')).toBeInTheDocument();
    expect(within(screen.getByTestId('user-row-me')).getByText('Tenant Owner')).toBeInTheDocument();
    expect(within(screen.getByTestId('user-row-fay')).getByText('No app access')).toBeInTheDocument();
    expect(within(screen.getByTestId('user-row-bob')).getByText('Invited Oct 18')).toBeInTheDocument();
    expect(within(ann).getByText('—')).toBeInTheDocument();
    // Active: Edit access · Disable; pending: Resend · Revoke; disabled: Enable.
    expect(within(ann).getByText('Edit access')).toBeInTheDocument();
    expect(within(ann).getByText('Disable')).toBeEnabled();
    expect(within(screen.getByTestId('user-row-me')).getByText('Disable')).toBeDisabled();
    for (const id of ['bob', 'cat', 'eve']) {
      expect(within(screen.getByTestId(`user-row-${id}`)).getByText('Resend')).toBeInTheDocument();
      expect(within(screen.getByTestId(`user-row-${id}`)).getByText('Revoke')).toBeInTheDocument();
    }
    expect(within(screen.getByTestId('user-row-dan')).getByText('Enable')).toBeInTheDocument();
    expect(screen.getByTestId('users-range')).toHaveTextContent('1–7 of 7');
  });

  it('search, the App access filter and the tabs combine; counts follow the filters; Clear resets', async () => {
    setup();
    await screen.findByText('Olive Owner');
    fireEvent.change(screen.getByLabelText('App access'), { target: { value: 'sign' } });
    // Sign holders: ann (ACTIVE), eve (FAILED).
    expect([tabCount('all'), tabCount('ACTIVE'), tabCount('FAILED'), tabCount('INVITED')]).toEqual(['2', '1', '1', '0']);
    fireEvent.change(screen.getByLabelText('Search people'), { target: { value: 'eve' } });
    expect([tabCount('all'), tabCount('ACTIVE'), tabCount('FAILED')]).toEqual(['1', '0', '1']);
    fireEvent.click(screen.getByTestId('tab-ACTIVE'));
    expect(screen.getByText('No one matches these filters.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(tabCount('ACTIVE')).toBe('3');
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    fireEvent.change(screen.getByLabelText('App access'), { target: { value: 'none' } });
    expect(tabCount('all')).toBe('1');
    expect(screen.getByText('Fay Admin')).toBeInTheDocument();
  });

  it('the App access select lists subscribed apps only', async () => {
    setup(ATS_ONLY);
    await screen.findByText('Olive Owner');
    const opts = within(screen.getByLabelText('App access')).getAllByRole('option').map((o) => o.textContent);
    expect(opts).toEqual(['All apps', 'Aramo ATS', 'No app access']);
  });

  it('bulk Disable and Resend skip yourself and only touch eligible people', async () => {
    const calls = setup();
    await screen.findByText('Olive Owner');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    const bar = screen.getByTestId('bulk-bar');
    expect(bar).toHaveAttribute('role', 'status');
    expect(bar).toHaveTextContent('7 selected');
    fireEvent.click(within(bar).getByText('Disable'));
    await waitFor(() => expect(posts(calls, '/disable').sort()).toEqual(['ann', 'fay']));
    expect(await screen.findByText('2 disabled. You can’t disable yourself.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    fireEvent.click(within(screen.getByTestId('bulk-bar')).getByText('Resend invitations'));
    await waitFor(() => expect(posts(calls, '/resend').sort()).toEqual(['bob', 'cat', 'eve']));
    expect(posts(calls, '/disable')).not.toContain('me');
  });

  it('row actions call the existing D-ORG endpoints and toast', async () => {
    const calls = setup();
    await screen.findByText('Olive Owner');
    fireEvent.click(screen.getByTestId('enable-dan'));
    await waitFor(() => expect(posts(calls, '/enable')).toEqual(['dan']));
    expect(await screen.findByText('Dan Disabled can sign in again.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('revoke-bob'));
    await waitFor(() => expect(posts(calls, '/revoke')).toEqual(['bob']));
    expect(await screen.findByText('Invitation revoked.')).toBeInTheDocument();
  });

  it('Edit access opens the modal for an active person', async () => {
    setup();
    await screen.findByText('Olive Owner');
    fireEvent.click(screen.getByTestId('edit-access-ann'));
    const modal = await screen.findByTestId('edit-access-modal');
    expect(within(modal).getByText('Edit access · Ann Active')).toBeInTheDocument();
    expect(within(modal).getByText('ann@acme.test · roles are assigned here; each app shows them read-only.')).toBeInTheDocument();
    expect(within(modal).getByRole('checkbox', { name: 'Recruiter' })).toHaveAttribute('aria-checked', 'true');
  });
});
