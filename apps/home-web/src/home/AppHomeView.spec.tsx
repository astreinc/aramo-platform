import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductAvailabilityView } from '@aramo/fe-foundation';

import { AppHomeView } from './AppHomeView';

// App Home — My applications (accepted App Home handoff §5, frozen prototype
// scenarios A–F). Rendered STRICTLY from the backend availability read.
type P = { subscribed: boolean; authorized: boolean; available: boolean; entry_path: string | null };
const OFF: P = { subscribed: false, authorized: false, available: false, entry_path: null };
function view(ats: P, esign: P, org: P = { subscribed: true, authorized: false, available: false, entry_path: null }): ProductAvailabilityView {
  const reason = (p: P) => (!p.subscribed ? 'not_subscribed' : !p.authorized ? 'not_authorized' : !p.available ? 'not_activated' : null);
  return {
    tenant_id: 't',
    products: [
      { key: 'ats', ...ats, reason: reason(ats) },
      { key: 'sign', ...esign, reason: reason(esign) },
      { key: 'org', ...org, reason: reason(org) },
    ],
  } as ProductAvailabilityView;
}
const READY_ATS: P = { subscribed: true, authorized: true, available: true, entry_path: '/ats/' };
const NOACCESS: P = { subscribed: true, authorized: false, available: false, entry_path: null };
const DARK_SIGN: P = { subscribed: true, authorized: true, available: false, entry_path: null };

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({ user: { display_name: 'Deepika Rao', email: 'd@acme.test' }, roles: ['Recruiter'], tenant: { display_name: 'Astre Consulting', status: 'ACTIVE' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
});
afterEach(() => vi.restoreAllMocks());

function renderHome(v: ProductAvailabilityView | Error, opts: { admin?: boolean; path?: string } = {}) {
  const fetchFn = () => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  return render(
    <MemoryRouter initialEntries={[opts.path ?? '/']}>
      <AppHomeView fetchFn={fetchFn} isOrgAdmin={opts.admin ?? false} now={new Date(2026, 9, 18, 9)} />
    </MemoryRouter>,
  );
}

describe('AppHomeView', () => {
  it('greets the person by first name with the organization', async () => {
    renderHome(view(READY_ATS, OFF));
    expect(await screen.findByRole('heading', { name: 'Good morning, Deepika' })).toBeInTheDocument();
    expect(screen.getAllByText(/Astre Consulting/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('home-start-page')).toHaveAttribute('href', '/preferences');
  });

  it('A · ATS-only tenant: ATS card Ready with Open → its entry path; Sign under Other Aramo products, Not subscribed, no link', async () => {
    renderHome(view(READY_ATS, OFF));
    const open = await screen.findByTestId('home-open-ats');
    expect(open).toHaveAttribute('href', '/ats/');
    expect(open).toHaveTextContent('Open ATS');
    expect(screen.getByTestId('home-other-sign')).toHaveTextContent('Not subscribed');
    expect(screen.queryByTestId('home-open-sign')).toBeNull();
    expect(screen.getByText(/managed by your organization admins/)).toBeInTheDocument();
  });

  it('C · ATS + Sign tenant, ATS-only user: Sign card shows No access with the reason and no Open', async () => {
    renderHome(view(READY_ATS, NOACCESS));
    const sign = await screen.findByTestId('home-tile-sign');
    expect(sign).toHaveTextContent('No access');
    expect(sign).toHaveTextContent('Astre Consulting has Sign, but you have no Sign role');
    expect(screen.queryByTestId('home-open-sign')).toBeNull();
  });

  it('Sign subscribed + authorized but dark: Not available yet, never enterable', async () => {
    renderHome(view(READY_ATS, DARK_SIGN));
    expect(await screen.findByTestId('home-tile-sign')).toHaveTextContent('Not available yet');
    expect(screen.queryByTestId('home-open-sign')).toBeNull();
  });

  it('E · organization admin without product roles: the note, no Open, and the Organization administration tiles', async () => {
    renderHome(view(NOACCESS, NOACCESS, { subscribed: true, authorized: true, available: true, entry_path: '/org/' }), { admin: true });
    expect(await screen.findByTestId('home-no-app-role')).toBeInTheDocument();
    expect(screen.queryByTestId('home-open-ats')).toBeNull();
    const tiles = screen.getByTestId('home-org-tiles');
    expect(tiles.querySelectorAll('a')).toHaveLength(7);
    expect(screen.getByTestId('home-org-roles')).toHaveAttribute('href', '/org/roles');
  });

  it('error state: "We couldn\'t load your applications" with Try again', async () => {
    renderHome(new Error('boom'));
    expect(await screen.findByText(/We couldn.t load your applications/)).toBeInTheDocument();
    expect(screen.getByTestId('home-retry')).toBeInTheDocument();
  });

  it('organization denial notice after a refused /org/* visit', async () => {
    renderHome(view(READY_ATS, OFF), { path: '/?notice=org-denied' });
    await waitFor(() => expect(screen.getByTestId('home-org-denied')).toHaveTextContent('Organization administration needs the organization admin role'));
  });
});
