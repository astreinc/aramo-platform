import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer, hasScope } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlatformConsole } from '../App';
import { visibleNavGroups } from '../shell/nav';

import { ROLE_SCOPES, SEVEN_ROLES, sessionFor, type FixtureRole } from './test-fixtures';

// CCP-B1 — per-role visibility (PBD §5.3 B1 row "per-role visibility"; CCP-UI v1.0
// handoff §2 and acceptance 1). The Commercial group's items are filtered by each
// item's commercial READ scope; super_admin (no commercial scope) sees no Commercial
// group, and a deep link renders the in-shell AccessDenied naming the six roles.

const ITEMS = ['Approvals', 'Subscriptions', 'Catalog', 'Contracts', 'Policy', 'Audit'] as const;

/** The expected Commercial items per role (from the A1 bundles; recorded in CCP-B1-acceptance.md). */
const EXPECTED: Readonly<Record<FixtureRole, readonly (typeof ITEMS)[number][]>> = {
  platform_owner: ['Approvals', 'Subscriptions', 'Catalog', 'Contracts', 'Policy', 'Audit'],
  finance_admin: ['Approvals', 'Subscriptions', 'Catalog', 'Contracts', 'Policy', 'Audit'],
  commercial_ops: ['Approvals', 'Subscriptions', 'Catalog', 'Contracts', 'Policy'],
  catalog_manager: ['Approvals', 'Catalog', 'Policy'],
  support_admin: ['Approvals', 'Subscriptions', 'Catalog', 'Contracts', 'Policy'],
  read_only_auditor: ['Approvals', 'Subscriptions', 'Catalog', 'Contracts', 'Policy', 'Audit'],
  super_admin: [],
};

const ROUTE: Readonly<Record<(typeof ITEMS)[number], string>> = {
  Approvals: '/commercial/approvals',
  Subscriptions: '/commercial/subscriptions',
  Catalog: '/commercial/catalog',
  Contracts: '/commercial/contracts',
  Policy: '/commercial/policy',
  Audit: '/commercial/audit',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function mockFetch(role: FixtureRole) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/platform/me')) {
      return json({ user_id: 'u1', email: `${role}@aramo.ai`, display_name: null, tenant_id: 't0', tenant_name: 'Aramo Platform', role_keys: [role] });
    }
    if (url.includes('/platform/commercial/change-requests')) {
      return hasScope(sessionFor(role), 'platform:approval:read') ? json({ requests: [], next_cursor: null }) : json({ error: { code: 'INSUFFICIENT_PERMISSIONS' } }, 403);
    }
    if (url.includes('/platform/tenants')) return json({ tenants: [] });
    if (url.includes('/platform/dashboard')) return json({ status_counts: [], onboarding: [], recent_activity: [] });
    return json({}, 404);
  });
}

function renderConsole(role: FixtureRole, path: string) {
  mockFetch(role);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PlatformConsole session={sessionFor(role)} />
    </MemoryRouter>,
  );
}

const rail = () => screen.getByRole('navigation', { name: /primary|platform/i });

describe('Commercial rail group — per-role visibility (6 roles + super_admin)', () => {
  beforeEach(() => configureAuthConsumer('platform'));
  afterEach(() => configureAuthConsumer('recruiter'));

  it.each(SEVEN_ROLES)('%s: the model shows exactly its readable Commercial items', (role) => {
    const can = (scope: string) => (ROLE_SCOPES[role] as readonly string[]).includes(scope);
    const commercial = visibleNavGroups(can).find((g) => g.label === 'Commercial');
    expect(commercial?.items.map((i) => i.label) ?? []).toEqual(EXPECTED[role]);
  });

  it('the group sits between Documents and Platform (handoff §2)', () => {
    const groups = visibleNavGroups(() => true).map((g) => g.label);
    expect(groups.indexOf('Commercial')).toBe(groups.indexOf('Documents') + 1);
    expect(groups.indexOf('Platform')).toBe(groups.indexOf('Commercial') + 1);
  });

  it.each(SEVEN_ROLES)('%s: the rendered rail', async (role) => {
    renderConsole(role, '/tenants');
    await screen.findByRole('link', { name: 'Tenants' });
    const nav = rail();
    for (const item of ITEMS) {
      const link = within(nav).queryByRole('link', { name: item });
      if (EXPECTED[role].includes(item)) expect(link, `${role} should see ${item}`).toHaveAttribute('href', ROUTE[item]);
      else expect(link, `${role} should not see ${item}`).toBeNull();
    }
    expect(within(nav).queryByText('Commercial')).toEqual(EXPECTED[role].length === 0 ? null : expect.anything());
  });
});

describe('Commercial routes — in-shell access denied, never a redirect', () => {
  beforeEach(() => configureAuthConsumer('platform'));
  afterEach(() => configureAuthConsumer('recruiter'));

  it.each(ITEMS)('super_admin deep link to %s renders AccessDenied naming the six roles', async (item) => {
    renderConsole('super_admin', ROUTE[item]);
    const denied = await screen.findByTestId('access-denied');
    expect(within(denied).getByRole('heading', { level: 1 })).toHaveTextContent(`This account can't open Commercial ${item.toLowerCase()}`);
    expect(await within(denied).findByText('Super admin holds no commercial authority. Commercial screens are open only to people with a commercial role.')).toBeInTheDocument();
    for (const r of ['Platform owner', 'Finance admin', 'Commercial ops', 'Catalog manager', 'Support admin', 'Read-only auditor']) {
      expect(within(denied).getByText(r)).toBeInTheDocument();
    }
    expect(within(denied).getByText('Super admin')).toBeInTheDocument();
    expect(within(denied).getByRole('button', { name: 'Sign in with a different account' })).toBeInTheDocument();
    expect(within(denied).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(within(denied).getByRole('button', { name: 'Back to dashboard' })).toBeInTheDocument();
    expect(within(denied).getByText('Tenant operations are unchanged for this account. Commercial authority is held only by the commercial roles above.')).toBeInTheDocument();
    // In the shell: the breadcrumb is Commercial / {page}; the URL did not change.
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent(`Commercial/${item}`);
  });

  it.each(SEVEN_ROLES.filter((r) => r !== 'super_admin'))('%s opens the Approvals inbox', async (role) => {
    renderConsole(role, '/commercial/approvals');
    expect(await screen.findByTestId('approvals-inbox')).toBeInTheDocument();
    expect(await screen.findByText('Nothing waiting on you')).toBeInTheDocument();
  });

  it('a commercial role without the page scope (commercial_ops → Audit) is denied in the shell', async () => {
    renderConsole('commercial_ops', '/commercial/audit');
    const denied = await screen.findByTestId('access-denied');
    expect(within(denied).getByText('Your roles don’t include access to this page.')).toBeInTheDocument();
    expect(within(denied).getByText('platform:commercial:audit:read')).toBeInTheDocument();
  });

  it('placeholders render the designed disabled state', async () => {
    renderConsole('platform_owner', '/commercial/catalog');
    expect(await screen.findByTestId('commercial-placeholder')).toHaveTextContent('The catalog isn’t available in the console yet');
  });

  it('super_admin tenant operations are unchanged (the Tenants list still opens)', async () => {
    renderConsole('super_admin', '/tenants');
    expect(await screen.findByRole('link', { name: 'Tenants' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByTestId('access-denied')).toBeNull();
  });
});
