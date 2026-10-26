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

// Merge train TD-MERGE-32: + CCP-B6 'Support extensions' (platform:subscription:read). CCP-UI-V12
// (AM-1): Support extensions sits after Policy, before Audit.
const ITEMS = ['Approvals', 'Subscriptions', 'Catalog', 'Contracts', 'Policy', 'Support extensions', 'Audit'] as const;

/** The expected Commercial items per role (from the A1 bundles; recorded in CCP-B1-acceptance.md). */
const EXPECTED: Readonly<Record<FixtureRole, readonly (typeof ITEMS)[number][]>> = {
  platform_owner: ['Approvals', 'Subscriptions', 'Catalog', 'Contracts', 'Policy', 'Support extensions', 'Audit'],
  finance_admin: ['Approvals', 'Subscriptions', 'Catalog', 'Contracts', 'Policy', 'Support extensions', 'Audit'],
  commercial_ops: ['Approvals', 'Subscriptions', 'Catalog', 'Contracts', 'Policy', 'Support extensions'],
  catalog_manager: ['Approvals', 'Catalog', 'Policy'],
  support_admin: ['Approvals', 'Subscriptions', 'Catalog', 'Contracts', 'Policy', 'Support extensions'],
  read_only_auditor: ['Approvals', 'Subscriptions', 'Catalog', 'Contracts', 'Policy', 'Support extensions', 'Audit'],
  super_admin: [],
};

/** CCP-UI-V12 (AM-1) — the v1.1 pages: group, label, route, read scope. */
const V11 = [
  ['Operations', 'Alerts', '/commercial/alerts', 'platform:billing:read'],
  ['Finance', 'Renewals', '/commercial/finance/renewals', 'platform:billing:read'],
  ['Finance', 'Outstanding payments', '/commercial/finance/outstanding-payments', 'platform:billing:read'],
  ['Finance', 'Billing reconciliation', '/commercial/finance/reconciliation', 'platform:billing:read'],
  ['Finance', 'Revenue', '/commercial/finance/revenue', 'platform:billing:read'],
  ['Usage', 'Consumption', '/commercial/usage', 'platform:subscription:read'],
] as const;

/** The five holders of platform:billing:read and platform:subscription:read (AM-2). */
const FIVE = ['Platform owner', 'Finance admin', 'Commercial ops', 'Support admin', 'Read-only auditor'];
const HOLDS_BILLING: readonly FixtureRole[] = ['platform_owner', 'finance_admin', 'commercial_ops', 'support_admin', 'read_only_auditor'];
/** Scope-gated Commercial pages (AM-2): the card names the scope and the five holders. */
const GATED: ReadonlySet<string> = new Set(['Subscriptions', 'Contracts', 'Support extensions']);

const ROUTE: Readonly<Record<(typeof ITEMS)[number], string>> = {
  Approvals: '/commercial/approvals',
  Subscriptions: '/commercial/subscriptions',
  Catalog: '/commercial/catalog',
  Contracts: '/commercial/contracts',
  Policy: '/commercial/policy',
  Audit: '/commercial/audit',
  'Support extensions': '/commercial/support-extensions',
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
    if (url.includes('/platform/commercial/subscriptions')) return json({ as_of: '2026-10-24T14:00:00.000Z', rows: [] });
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

  it('the group sits between Documents and Platform, with Finance and Usage after it (handoff §2; AM-1)', () => {
    const groups = visibleNavGroups(() => true).map((g) => g.label);
    expect(groups.indexOf('Commercial')).toBe(groups.indexOf('Documents') + 1);
    expect(groups.slice(groups.indexOf('Commercial'))).toEqual(['Commercial', 'Finance', 'Usage', 'Platform']);
    const ops = visibleNavGroups(() => true).find((g) => g.label === 'Operations');
    expect(ops?.items.map((i) => i.label)).toEqual(['Dashboard', 'Tenants', 'Alerts']);
  });

  it.each(SEVEN_ROLES)('%s: AM-1 Finance, Usage and Alerts follow platform:billing:read / platform:subscription:read', (role) => {
    const can = (scope: string) => (ROLE_SCOPES[role] as readonly string[]).includes(scope);
    const groups = visibleNavGroups(can);
    for (const [group, label, , scope] of V11) {
      const shown = groups.find((g) => g.label === group)?.items.some((i) => i.label === label) === true;
      expect(shown, `${role} / ${label}`).toBe(can(scope));
      expect(shown).toBe(HOLDS_BILLING.includes(role));
    }
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

  it.each(ITEMS)('super_admin deep link to %s renders AccessDenied naming the roles that grant it (six; five on a scope-gated page, AM-2)', async (item) => {
    renderConsole('super_admin', ROUTE[item]);
    const denied = await screen.findByTestId('access-denied');
    expect(within(denied).getByRole('heading', { level: 1 })).toHaveTextContent(`This account can't open Commercial ${item.toLowerCase()}`);
    expect(await within(denied).findByText('Super admin holds no commercial authority. Commercial screens are open only to people with a commercial role.')).toBeInTheDocument();
    for (const r of FIVE) expect(within(denied).getByText(r)).toBeInTheDocument();
    if (GATED.has(item)) expect(within(denied).queryByText('Catalog manager')).toBeNull();
    else expect(within(denied).getByText('Catalog manager')).toBeInTheDocument();
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

  it('TD-B4-3 (merge train) catalog_manager: Contracts is not in the rail, and a deep link to /commercial/contracts is denied in the shell', async () => {
    renderConsole('catalog_manager', '/commercial/contracts');
    const denied = await screen.findByTestId('access-denied');
    // CCP-UI-V12 (AM-2): the scope-gated card names the scope.
    expect(within(denied).getByText('This page needs the platform:subscription:read scope, which your role doesn’t hold.')).toBeInTheDocument();
    expect(within(denied).getByText('platform:subscription:read')).toBeInTheDocument();
    expect(within(rail()).queryByRole('link', { name: 'Contracts' })).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Commercial/Contracts');
  });

  it('CCP-B3: /commercial/subscriptions renders the workbench (B1 placeholder replaced)', async () => {
    renderConsole('platform_owner', '/commercial/subscriptions');
    expect(await screen.findByTestId('commercial-subscriptions')).toBeInTheDocument();
    expect(screen.queryByTestId('commercial-placeholder')).toBeNull();
  });

  it.each(V11.map((v) => [v[1], v[2], v[3]] as const))('AM-2 catalog_manager deep link to %s: the card names its scope and the five holder roles', async (label, route, scope) => {
    renderConsole('catalog_manager', route);
    const denied = await screen.findByTestId('access-denied');
    expect(within(denied).getByRole('heading', { level: 1 })).toHaveTextContent(`This account can't open ${label}`);
    expect(within(denied).getByText(`This page needs the ${scope} scope, which your role doesn’t hold.`)).toBeInTheDocument();
    const grants = denied.querySelector('.pw-denied__grants') as HTMLElement;
    for (const r of FIVE) expect(within(grants).getByText(r)).toBeInTheDocument();
    expect(within(grants).queryByText('Catalog manager')).toBeNull();
    expect(within(denied).getByText(scope)).toBeInTheDocument();
  });

  it.each(V11.map((v) => [v[1], v[2]] as const))('super_admin deep link to %s renders the in-shell card (never a redirect)', async (label, route) => {
    renderConsole('super_admin', route);
    const denied = await screen.findByTestId('access-denied');
    expect(within(denied).getByRole('heading', { level: 1 })).toHaveTextContent(`This account can't open ${label}`);
    expect(within(denied).getByText('Super admin holds no commercial authority. Commercial screens are open only to people with a commercial role.')).toBeInTheDocument();
  });

  it('super_admin tenant operations are unchanged (the Tenants list still opens)', async () => {
    renderConsole('super_admin', '/tenants');
    expect(await screen.findByRole('link', { name: 'Tenants' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByTestId('access-denied')).toBeNull();
  });
});
