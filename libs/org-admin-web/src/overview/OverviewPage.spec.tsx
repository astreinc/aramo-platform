import { ToastProvider, type ProductAvailabilityView } from '@aramo/fe-foundation';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditEventView } from '../audit/types';

import { OverviewPage, peopleCounts, shortWhen, subscribedApps } from './OverviewPage';
import { domain, profile, site, user } from './setup.fixture';
import type { OrgSetupFetchers } from './setup-checklist';

// ORG-UX-1 (§8.9; handoff §6.1) — Overview tiles, checklist rows and recent changes.

const PRODUCTS: ProductAvailabilityView = {
  tenant_id: 't1',
  products: [
    { key: 'ats', subscribed: true, authorized: true, available: true, entry_path: '/ats/', reason: null },
    { key: 'sign', subscribed: true, authorized: false, available: false, entry_path: null, reason: 'not_authorized' },
    { key: 'org', subscribed: true, authorized: true, available: true, entry_path: '/org/', reason: null, org_access: 'admin' },
  ],
};

const USERS = [
  user('a'),
  user('b'),
  user('c', { invite_status: 'INVITED' }),
  user('d', { invite_status: 'ACCEPTED' }),
  user('e', { is_active: false }),
  user('f', { invite_status: 'FAILED' }),
];

const FETCHERS: OrgSetupFetchers = {
  profile: () => Promise.resolve(profile({ country_code: 'US' })),
  domain: () => Promise.resolve(domain({ status: 'PENDING' })),
  users: () => Promise.resolve(USERS),
  sites: () => Promise.resolve([site('s1'), site('s2'), site('s3')]),
  templates: () => Promise.resolve([{ id: 'x', tenant_id: null, name: 'Aramo RTR', status: 'ACTIVE' }]),
};

const AUDIT: readonly AuditEventView[] = [
  { id: 'e1', event_type: 'identity.invitation.created', category: 'user', actor: { id: 'u', type: 'user', display: 'Purush P' }, subject_id: 's', detail: 'tom@acme.test', created_at: '2026-10-21T09:14:00' },
  { id: 'e2', event_type: 'identity.invitation.accepted', category: 'user', actor: { id: 'u', type: 'user', display: 'Tom' }, subject_id: 's', detail: '', created_at: '2026-10-21T10:00:00' },
];

const fetchAudit = () => Promise.resolve(AUDIT);

beforeEach(() => {
  // OrgPageHeader reads /v1/me for the org name.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ user: { display_name: 'P', email: 'p@acme.test' }, roles: [], tenant: { display_name: 'Acme', status: 'ACTIVE' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
});

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <OverviewPage products={PRODUCTS} fetchers={FETCHERS} fetchAudit={fetchAudit} />
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('Overview pure helpers', () => {
  it('peopleCounts: active, invited (Invited + Accepted), disabled', () => {
    expect(peopleCounts(USERS)).toEqual({ active: 2, invited: 2, disabled: 1 });
  });
  it('subscribedApps lists subscribed apps only, never the Organization entry', () => {
    expect(subscribedApps(PRODUCTS)).toEqual(['Aramo ATS', 'Aramo Sign']);
    expect(subscribedApps(null)).toEqual([]);
  });
  it('shortWhen formats "Mon D HH:MM"', () => {
    expect(shortWhen('2026-10-21T09:14:00')).toBe('Oct 21 09:14');
  });
});

describe('OverviewPage', () => {
  it('renders the header with Invite user', async () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite user' })).toBeInTheDocument();
  });

  it('renders the four tiles with values, sublines and links to their sections', async () => {
    renderPage();
    const people = screen.getByTestId('overview-tile-people');
    await waitFor(() => expect(people).toHaveTextContent('2'));
    expect(people).toHaveTextContent('2 invited · 1 disabled');
    expect(people).toHaveAttribute('href', '/org/users');

    const apps = screen.getByTestId('overview-tile-apps');
    await waitFor(() => expect(apps).toHaveTextContent('Aramo ATS · Aramo Sign'));
    expect(apps).toHaveAttribute('href', '/org/roles');

    const sites = screen.getByTestId('overview-tile-sites');
    expect(sites).toHaveTextContent('3');
    expect(sites).toHaveTextContent('Offices and locations');
    expect(sites).toHaveAttribute('href', '/org/sites');

    const dom = screen.getByTestId('overview-tile-domain');
    expect(dom).toHaveTextContent('Checking…');
    expect(dom).toHaveTextContent('acme.test');
    expect(dom).toHaveAttribute('href', '/org/domain');
    expect(within(dom).getByText('Checking…')).toHaveStyle({ color: '#011F8D' });
  });

  it('renders the checklist with done count, Finish/View and row links', async () => {
    renderPage();
    const card = screen.getByTestId('overview-checklist');
    await waitFor(() => expect(card).toHaveTextContent('3 of 5 done'));
    const profileRow = screen.getByTestId('setup-item-profile');
    expect(profileRow).toHaveAttribute('href', '/org/profile');
    expect(profileRow).toHaveTextContent('View');
    const domainRow = screen.getByTestId('setup-item-domain');
    expect(domainRow).toHaveTextContent('Finish');
    expect(domainRow).toHaveAttribute('href', '/org/domain');
    // A platform (legacy Aramo-default) template does not count.
    expect(screen.getByTestId('setup-item-template')).toHaveTextContent('Finish');
    expect(screen.getByTestId('setup-item-template')).toHaveAttribute('href', '/org/document-templates');
  });

  it('renders the recent audit entries and the View audit link', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('overview-audit-row')).toHaveLength(2));
    const [first] = screen.getAllByTestId('overview-audit-row');
    expect(first).toHaveTextContent('Oct 21 09:14');
    expect(first).toHaveTextContent('Purush P invitation sent tom@acme.test');
    expect(screen.getByRole('link', { name: 'View audit →' })).toHaveAttribute('href', '/org/audit');
  });

  it('shows "—" rather than numbers when the sources fail', async () => {
    const failing: OrgSetupFetchers = { ...FETCHERS, users: () => Promise.reject(new Error('nope')) };
    render(
      <ToastProvider>
        <MemoryRouter>
          <OverviewPage products={PRODUCTS} fetchers={failing} fetchAudit={fetchAudit} />
        </MemoryRouter>
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('couldn’t be loaded'));
    expect(screen.getByTestId('overview-tile-people')).toHaveTextContent('—');
  });
});
