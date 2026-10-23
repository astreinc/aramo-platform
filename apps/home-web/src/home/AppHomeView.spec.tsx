import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductAvailabilityView } from '@aramo/fe-foundation';

import { AppHomeView } from './AppHomeView';

// ORG-UX-1 — the setup checklist and the invite modal are org-admin-web contracts
// (implemented by the Overview / Users work); pinned here so App Home's own behaviour
// is tested deterministically.
const checklist = vi.hoisted(() => ({ state: { status: 'loading' } as unknown }));
vi.mock('@aramo/org-admin-web', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aramo/org-admin-web')>();
  return {
    ...actual,
    useSetupChecklist: () => checklist.state,
    InviteUserModal: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="Invite user" /> : null),
  };
});

// App Home — My applications (accepted App Home handoff §5, frozen prototype
// scenarios A–F). Rendered STRICTLY from the backend availability read.
type P = { subscribed: boolean; authorized: boolean; available: boolean; entry_path: string | null };
const OFF: P = { subscribed: false, authorized: false, available: false, entry_path: null };
type Org = P & { org_access?: 'admin' | 'templates' | 'none' };
function view(ats: P, esign: P, org: Org = { subscribed: true, authorized: false, available: false, entry_path: null, org_access: 'none' }): ProductAvailabilityView {
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
const ORG_ADMIN: Org = { subscribed: true, authorized: true, available: true, entry_path: '/org/', org_access: 'admin' };
const ORG_TEMPLATES: Org = { subscribed: true, authorized: true, available: true, entry_path: '/org/document-templates', org_access: 'templates' };

const USERS = [
  { is_active: true, invite_status: 'ACTIVE' },
  { is_active: true, invite_status: 'ACTIVE' },
  { is_active: true, invite_status: 'INVITED' },
  { is_active: true, invite_status: 'ACCEPTED' },
  { is_active: false, invite_status: 'ACTIVE' },
  { is_active: true, invite_status: 'FAILED' },
];
const TEMPLATES = [{ status: 'ACTIVE' }, { status: 'DRAFT' }, { status: 'ACTIVE' }, { status: 'RETIRED' }];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  checklist.state = { status: 'loading' };
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/v1/tenant/users')) return json({ items: USERS });
    if (url.includes('/v1/document-templates')) return json(TEMPLATES);
    return json({ user: { display_name: 'Deepika Rao', email: 'd@acme.test' }, roles: ['Recruiter'], tenant: { display_name: 'Astre Consulting', status: 'ACTIVE' } });
  });
});
const calledWith = (fragment: string) => fetchSpy.mock.calls.some(([input]) => String(input instanceof Request ? input.url : input).includes(fragment));
afterEach(() => vi.restoreAllMocks());

function renderHome(v: ProductAvailabilityView | Error, opts: { path?: string } = {}) {
  const fetchFn = () => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  return render(
    <MemoryRouter initialEntries={[opts.path ?? '/']}>
      <AppHomeView fetchFn={fetchFn} now={new Date(2026, 9, 18, 9)} />
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
    expect(open).toHaveAttribute('href', '/auth/recruiter/login?return_to=%2Fats%2F');
    expect(open).toHaveTextContent('Open ATS');
    expect(screen.getByTestId('home-other-sign')).toHaveTextContent('Not subscribed');
    expect(screen.queryByTestId('home-open-sign')).toBeNull();
    expect(screen.getByText(/managed by your organization admins/)).toBeInTheDocument();
  });

  // ATI-SEP-1 T9 — the Talent Intelligence tile is shown ONLY when the organization subscribes.
  function withIntelligence(v: ProductAvailabilityView, p: P): ProductAvailabilityView {
    const reason = !p.subscribed ? 'not_subscribed' : !p.authorized ? 'not_authorized' : !p.available ? 'not_activated' : null;
    return { ...v, products: [...v.products, { key: 'intelligence', ...p, reason }] } as ProductAvailabilityView;
  }

  it('T9 · Talent Intelligence NOT subscribed: no tile and never listed under Other Aramo products', async () => {
    renderHome(withIntelligence(view(READY_ATS, OFF), OFF));
    expect(await screen.findByTestId('home-open-ats')).toBeInTheDocument();
    expect(screen.queryByTestId('home-tile-intelligence')).toBeNull();
    expect(screen.queryByTestId('home-other-intelligence')).toBeNull();
    expect(screen.getByTestId('home-other-sign')).toBeInTheDocument();
  });

  it('T9 · Talent Intelligence subscribed: its tile opens inside the ATS', async () => {
    renderHome(withIntelligence(view(READY_ATS, OFF), READY_ATS));
    const tile = await screen.findByTestId('home-tile-intelligence');
    expect(tile).toHaveTextContent('Talent Intelligence');
    expect(screen.getByTestId('home-open-intelligence')).toHaveAttribute('href', '/auth/recruiter/login?return_to=%2Fats%2F');
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

  it('E · organization admin without product roles: the note, no Open, Your organization (Setup + Shortcuts) and NO link tiles', async () => {
    renderHome(view(NOACCESS, NOACCESS, ORG_ADMIN));
    expect(await screen.findByTestId('home-no-app-role')).toBeInTheDocument();
    expect(screen.queryByTestId('home-open-ats')).toBeNull();
    const yours = screen.getByTestId('home-your-org');
    expect(yours).toHaveTextContent('Your organization');
    expect(yours).toHaveTextContent('ADMIN');
    expect(screen.queryByTestId('home-org-tiles')).toBeNull();
    expect(screen.getByTestId('home-open-org')).toHaveAttribute('href', '/org/overview');
    expect(screen.getByTestId('home-shortcut-roles')).toHaveAttribute('href', '/org/roles');
    expect(screen.getByTestId('home-shortcut-roles-sub')).toHaveTextContent('Who holds each role');
    expect(screen.getByTestId('home-shortcut-users')).toHaveAttribute('href', '/org/users');
    expect(screen.getByTestId('home-shortcut-templates')).toHaveAttribute('href', '/org/document-templates');
    expect(screen.queryByText(/managed by your organization admins/)).toBeNull();
  });

  it('Shortcuts: users "{a} active · {i} invited" (INVITED+ACCEPTED invited; disabled/failed neither) and Our templates "{n} active"', async () => {
    renderHome(view(READY_ATS, OFF, ORG_ADMIN));
    expect(await screen.findByTestId('home-shortcut-users-sub')).toHaveTextContent('2 active · 2 invited');
    expect(await screen.findByTestId('home-shortcut-templates-sub')).toHaveTextContent(/^2 active$/);
    expect(screen.queryByText(/gallery has/)).toBeNull();
  });

  it('Shortcuts: Invite user opens the invite form in place', async () => {
    renderHome(view(READY_ATS, OFF, ORG_ADMIN));
    fireEvent.click(await screen.findByTestId('home-shortcut-invite'));
    expect(screen.getByRole('dialog', { name: 'Invite user' })).toBeInTheDocument();
  });

  it('Setup card: a skeleton while the checklist loads, then progress + the first 2 unfinished items', async () => {
    const { unmount } = renderHome(view(READY_ATS, OFF, ORG_ADMIN));
    expect(await screen.findByTestId('home-org-setup-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('home-org-setup-progress')).toBeNull();
    unmount();
    checklist.state = {
      status: 'ready',
      done: 2,
      total: 5,
      items: [
        { key: 'profile', label: 'Complete the organization profile', hint: 'Add your address', done: true, path: '/org/profile' },
        { key: 'domain', label: 'Verify your email domain', hint: 'Not verified', done: false, path: '/org/domain' },
        { key: 'team', label: 'Invite your team', hint: 'Only you so far', done: true, path: '/org/users' },
        { key: 'sites', label: 'Add your sites', hint: 'No sites yet', done: false, path: '/org/sites' },
        { key: 'template', label: 'Approve a document template', hint: 'None approved', done: false, path: '/org/document-templates' },
      ],
    };
    renderHome(view(READY_ATS, OFF, ORG_ADMIN));
    expect(await screen.findByTestId('home-org-setup-progress')).toHaveTextContent('Setup · 2 of 5 done');
    expect(screen.getByTestId('home-setup-domain')).toHaveAttribute('href', '/org/domain');
    expect(screen.getByTestId('home-setup-sites')).toHaveAttribute('href', '/org/sites');
    expect(screen.queryByTestId('home-setup-template')).toBeNull();
    expect(screen.queryByTestId('home-setup-profile')).toBeNull();
  });

  it('a template author (org_access templates) does NOT see Your organization, and no admin reads are made', async () => {
    renderHome(view(READY_ATS, OFF, ORG_TEMPLATES));
    expect(await screen.findByText(/managed by your organization admins/)).toBeInTheDocument();
    expect(screen.queryByTestId('home-your-org')).toBeNull();
    expect(calledWith('/v1/tenant/users')).toBe(false);
    expect(calledWith('/v1/document-templates')).toBe(false);
  });

  it('org admin flag never comes from the availability flag alone: org available but org_access none → no Your organization', async () => {
    renderHome(view(READY_ATS, OFF, { subscribed: true, authorized: true, available: true, entry_path: '/org/', org_access: 'none' }));
    expect(await screen.findByText(/managed by your organization admins/)).toBeInTheDocument();
    expect(screen.queryByTestId('home-your-org')).toBeNull();
  });

  it('no attention line is rendered on app cards (no authorized count source — G7/G8)', async () => {
    renderHome(view(READY_ATS, { subscribed: true, authorized: true, available: true, entry_path: '/sign/' }, ORG_ADMIN));
    expect(await screen.findByTestId('home-open-ats')).toBeInTheDocument();
    expect(screen.queryByTestId('home-attention-ats')).toBeNull();
    expect(screen.queryByTestId('home-attention-sign')).toBeNull();
    expect(screen.queryByText(/due today|waiting for your signature/)).toBeNull();
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
