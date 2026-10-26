// CCP-D4 — end-to-end journeys per role (6 commercial roles + super_admin), against the BUILD
// with the test-only fixture provider (no backend). One `describe` per role, so the per-role pass
// counts read straight off the report. Each journey shares ONE stateful world across the people
// it crosses (fixtures/ccp-d4-world.ts): a request made by one persona is approved by another and
// applied by the first, on the same data, by re-opening the build as each person in turn.
//
// Authority (doc/ccp/decisions.md): TD-B2-3 / TD-A6-3 (Apply = the requester only, once
// approved); TD-A3-2 / TD-A3-6 (Finance-only chain for conversion and the escalated support
// extension; Finance → Owner for catalog publish; a Finance step needs finance_admin); TD-B4-3
// (catalog_manager has no Contracts); super_admin holds no commercial authority (CCP-B1). The
// rail matrix restates src/commercial/commercial-visibility.spec.tsx.

import { expect, test, type Page } from '@playwright/test';

import { B3_TENANTS, tenantPath } from '../fixtures/ccp-subscriptions';
import { D4World, PERSON_OF, type D4Person, type D4Role } from '../fixtures/ccp-d4-world';
import { openBuild } from '../support/build';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

const ITEMS = ['Approvals', 'Subscriptions', 'Catalog', 'Contracts', 'Policy', 'Audit', 'Support extensions'] as const;
type Item = (typeof ITEMS)[number];

/** The rail's Commercial items per role (commercial-visibility.spec.tsx EXPECTED). */
const EXPECTED: Readonly<Record<D4Role, readonly Item[]>> = {
  platform_owner: ['Approvals', 'Subscriptions', 'Catalog', 'Contracts', 'Policy', 'Audit', 'Support extensions'],
  finance_admin: ['Approvals', 'Subscriptions', 'Catalog', 'Contracts', 'Policy', 'Audit', 'Support extensions'],
  commercial_ops: ['Approvals', 'Subscriptions', 'Catalog', 'Contracts', 'Policy', 'Support extensions'],
  catalog_manager: ['Approvals', 'Catalog', 'Policy'],
  support_admin: ['Approvals', 'Subscriptions', 'Catalog', 'Contracts', 'Policy', 'Support extensions'],
  read_only_auditor: ['Approvals', 'Subscriptions', 'Catalog', 'Contracts', 'Policy', 'Audit', 'Support extensions'],
  super_admin: [],
};
const ROUTE: Readonly<Record<Item, string>> = {
  Approvals: '/commercial/approvals',
  Subscriptions: '/commercial/subscriptions',
  Catalog: '/commercial/catalog',
  Contracts: '/commercial/contracts',
  Policy: '/commercial/policy',
  Audit: '/commercial/audit',
  'Support extensions': '/commercial/support-extensions',
};
/** The page's h1 when it opens. */
const HEADING: Readonly<Record<Item, string>> = {
  Approvals: 'Approvals',
  Subscriptions: 'Subscriptions',
  Catalog: 'Catalog',
  Contracts: 'Contracts',
  Policy: 'Commercial policy',
  Audit: 'Commercial audit',
  'Support extensions': 'Support extensions',
};
/** The route gate's scope (App.tsx commercialGate). */
const SCOPE: Readonly<Record<Item, string>> = {
  Approvals: 'platform:approval:read',
  Subscriptions: 'platform:subscription:read',
  Catalog: 'platform:catalog:read',
  Contracts: 'platform:subscription:read',
  Policy: 'platform:approval:read',
  Audit: 'platform:commercial:audit:read',
  'Support extensions': 'platform:subscription:read',
};

const SUPER_ADMIN_WHY = 'Super admin holds no commercial authority. Commercial screens are open only to people with a commercial role.';
const MISSING_PAGE_WHY = 'Your roles don’t include access to this page.';
// Merge train TD-MERGE-51 (CCP-UI-V12 AM-2): a page gated on platform:billing:read or
// platform:subscription:read names the scope it needs (CommercialAccessDenied scopeGatedWhy).
const SCOPE_GATED = ['platform:billing:read', 'platform:subscription:read'];
const whyFor = (role: string, scope: string): string =>
  role === 'super_admin' ? SUPER_ADMIN_WHY : SCOPE_GATED.includes(scope) ? `This page needs the ${scope} scope, which your role doesn’t hold.` : MISSING_PAGE_WHY;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Re-opens the build as `who` on `path`, answered from the shared world. */
async function as(page: Page, w: D4World, who: D4Person, path: string): Promise<void> {
  // The newest page.route wins, so each re-open answers from this person's view of the world.
  await openBuild(page, path, w.mock(who));
}

const toast = (page: Page, text: string | RegExp) => expect(page.getByText(text).first()).toBeVisible();
const verdict = (page: Page) => page.getByTestId('eligibility-verdict');
const drawerPath = (id: string) => `/commercial/approvals?request=${id}`;
const signCard = (page: Page) => page.locator('section[data-product="sign"]');

/** Opened on the Dashboard: it stays open to every role, with no money on it (TD-B1-2). */
async function expectRail(page: Page, role: D4Role): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.getByTestId('access-denied')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('$');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.getByRole('link', { name: 'Tenants', exact: true })).toBeVisible();
  for (const item of ITEMS) {
    const link = nav.getByRole('link', { name: item, exact: true });
    if (EXPECTED[role].includes(item)) await expect(link, `${role} should see ${item}`).toHaveAttribute('href', ROUTE[item]);
    else await expect(link, `${role} should not see ${item}`).toHaveCount(0);
  }
  if (EXPECTED[role].length === 0) await expect(nav.getByText('Commercial', { exact: true })).toHaveCount(0);
  else await expect(nav.getByText('Commercial', { exact: true })).toBeVisible();
}

/** Every Commercial deep link: the screen for an entitled role, else the in-shell access-denied card. */
async function expectRoutes(page: Page, w: D4World, role: D4Role): Promise<void> {
  for (const item of ITEMS) {
    await as(page, w, PERSON_OF[role], ROUTE[item]);
    const denied = page.getByTestId('access-denied');
    if (EXPECTED[role].includes(item)) {
      await expect(page.getByRole('heading', { level: 1, name: HEADING[item], exact: true }), `${role} opens ${item}`).toBeVisible();
      await expect(denied).toHaveCount(0);
    } else {
      await expect(denied, `${role} is denied ${item}`).toBeVisible();
      await expect(denied.getByRole('heading', { level: 1 })).toHaveText(`This account can't open Commercial ${item.toLowerCase()}`);
      await expect(denied.getByText(whyFor(role, SCOPE[item]))).toBeVisible();
      await expect(denied.getByText(SCOPE[item], { exact: true })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${ROUTE[item]}$`)); // never a redirect
    }
  }
}

/** Opens the drawer as `who` and signs the next step through the confirm dialog. */
async function approveInDrawer(page: Page, w: D4World, who: D4Person, id: string, step: 'Finance' | 'Owner'): Promise<void> {
  await as(page, w, who, drawerPath(id));
  await expect(verdict(page)).toHaveText(new RegExp(`You can sign the ${step} step`));
  await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
  const confirm = page.getByRole('dialog', { name: new RegExp(`^Approve the ${step} step`) });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(confirm).toBeHidden();
}

/** The drawer refuses this person: the verdict, Approve and Reject… disabled, the footnote. */
async function expectRefused(page: Page, w: D4World, who: D4Person, id: string, label: string): Promise<void> {
  await as(page, w, who, drawerPath(id));
  await expect(verdict(page)).toHaveText(new RegExp(`You can’t approve: ${label}`));
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reject…', exact: true })).toBeDisabled();
  await expect(page.getByTestId('cr-footnote')).toHaveText(`${label}.`);
}

const catalogV3 = '/commercial/catalog?plan=team&version=3';
const sxFernhill = `/commercial/support-extensions?tenant=${B3_TENANTS.fernhill}`;
const sxQuarry = `/commercial/support-extensions?tenant=${B3_TENANTS.quarry}`;
const seedConversion = (w: D4World) => w.seed('tomas', 'CONVERSION', { tenant_id: B3_TENANTS.fernhill, payload: { direction: 'TO_GOVERNED', subscription_id: 'cb300000-0000-7000-8000-000000000055', plan_key: 'aramo-sign-starter-v1', plan_version_id: 'starter-v2' }, reason: 'Moving to a contract.' });

// ── platform_owner ───────────────────────────────────────────────────────────

test.describe('platform_owner', () => {
  test('PO-1 · Dashboard (no money) + rail: every Commercial item', async ({ page }) => {
    await as(page, new D4World(), 'daniel', '/');
    await expectRail(page, 'platform_owner');
  });

  test('PO-2 · routes: all seven Commercial screens open', async ({ page }) => {
    await expectRoutes(page, new D4World(), 'platform_owner');
  });

  test('PO-3 · catalog publish: the Owner step waits for Finance, then the Owner signs; Apply stays with the requester', async ({ page }) => {
    const w = new D4World();
    const r = w.seedTeamV3Publish();
    await expectRefused(page, w, 'daniel', r.id, 'Out of order');
    w.sign('priya', r);
    await approveInDrawer(page, w, 'daniel', r.id, 'Owner');
    await toast(page, / approved\./); // CCP-UI-V12 D-1: the toast goes on to name who applies, and until when
    expect(w.find(r.id)?.state).toBe('APPROVED');
    // The Owner approved but is not the requester: no Apply on the catalog (TD-B2-3).
    await as(page, w, 'daniel', catalogV3);
    await expect(page.getByTestId('open-request')).toContainText('is approved.');
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0);
    expect(w.log.filter((l) => l.includes(' apply '))).toEqual([]);
  });

  test('PO-4 · escalated support extension and conversion are Finance-only: the Owner cannot sign them (TD-A3-2, TD-A3-6)', async ({ page }) => {
    const w = new D4World();
    const ext = w.seedEscalatedExtension();
    await expectRefused(page, w, 'daniel', ext.id, 'Missing the scope for this step');
    const conv = seedConversion(w);
    await expectRefused(page, w, 'daniel', conv.id, 'Missing the scope for this step');
  });

  test('PO-5 · requests are not the Owner’s: Tenant › Commercial is view-only and conversion is disabled', async ({ page }) => {
    const w = new D4World();
    await as(page, w, 'daniel', tenantPath('fernhill'));
    await expect(page.getByTestId('tenant-commercial').getByRole('note')).toContainText('View only.');
    await expect(signCard(page).getByRole('button', { name: 'Request conversion to MANUAL…' })).toBeDisabled();
    await expect(signCard(page).getByRole('button', { name: 'Request support extension…' })).toBeDisabled();
  });

  test('PO-6 · contracts open; the audit trail shows the full chain of an applied publish', async ({ page }) => {
    const w = new D4World();
    const r = w.seedTeamV3Publish(['priya', 'daniel']);
    w.applyAs('lena', r);
    await as(page, w, 'daniel', '/commercial/contracts');
    await expect(page.getByRole('heading', { level: 1, name: 'Contracts' })).toBeVisible();
    await expect(page.getByRole('button', { name: /CT-2024-007/ })).toBeVisible();
    await as(page, w, 'daniel', '/commercial/audit');
    const table = page.getByLabel('Commercial audit events');
    for (const label of ['Change request drafted', 'Change request submitted', 'Approval step signed', 'Change request approved', 'Change applied']) {
      await expect(table.getByText(label, { exact: true }).first(), label).toBeVisible();
    }
    await expect(table.getByText('Lena Fischer').first()).toBeVisible();
  });

  test('PO-7 · one person holding Finance admin + Platform owner fills at most one step', async ({ page }) => {
    const w = new D4World();
    const r = w.seedTeamV3Publish();
    await approveInDrawer(page, w, 'arjun', r.id, 'Finance');
    await toast(page, 'Finance step signed. Waiting on the next approver.');
    await expectRefused(page, w, 'arjun', r.id, 'You already approved a step');
    expect(w.approvalsOf(r.id).map((a) => a.step_role_key)).toEqual(['finance_admin']);
  });
});

// ── finance_admin ────────────────────────────────────────────────────────────

test.describe('finance_admin', () => {
  test('FA-1 · Dashboard (no money) + rail: every Commercial item', async ({ page }) => {
    await as(page, new D4World(), 'priya', '/');
    await expectRail(page, 'finance_admin');
  });

  test('FA-2 · routes: all seven Commercial screens open', async ({ page }) => {
    await expectRoutes(page, new D4World(), 'finance_admin');
  });

  test('FA-3 · catalog publish: Waiting on me → drawer → sign the Finance step; then refused on the Owner step', async ({ page }) => {
    const w = new D4World();
    const r = w.seedTeamV3Publish();
    await as(page, w, 'priya', '/commercial/approvals');
    await expect(page.getByRole('tab', { name: /^Waiting on me/ })).toContainText('1');
    await page.getByTestId(`cr-row-${r.id}`).click();
    await expect(verdict(page)).toHaveText(/You can sign the Finance step/);
    await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
    const confirm = page.getByRole('dialog', { name: /^Approve the Finance step/ });
    await expect(confirm).toContainText('You sign the Finance step as Finance admin.');
    await confirm.getByRole('button', { name: 'Approve', exact: true }).click();
    await toast(page, 'Finance step signed. Waiting on the next approver.');
    await expectRefused(page, w, 'priya', r.id, 'You already approved a step');
  });

  test('FA-4 · escalated support extension: Finance signs the only step; Apply is not offered to Finance', async ({ page }) => {
    const w = new D4World();
    const r = w.seedEscalatedExtension();
    await approveInDrawer(page, w, 'priya', r.id, 'Finance');
    await toast(page, / approved\./); // CCP-UI-V12 D-1: the toast goes on to name who applies, and until when
    expect(w.find(r.id)?.state).toBe('APPROVED');
    await as(page, w, 'priya', sxFernhill);
    await expect(page.getByText(/Open request/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0);
  });

  test('FA-5 · conversion: Finance signs; Tenant › Commercial offers Finance no Apply', async ({ page }) => {
    const w = new D4World();
    const r = seedConversion(w);
    await approveInDrawer(page, w, 'priya', r.id, 'Finance');
    await toast(page, / approved\./); // CCP-UI-V12 D-1: the toast goes on to name who applies, and until when
    await as(page, w, 'priya', tenantPath('fernhill'));
    await expect(signCard(page).getByTestId('open-request')).toBeVisible();
    await expect(signCard(page).getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0);
  });

  test('FA-6 · self-approval is refused: a request Finance made itself cannot be signed by it', async ({ page }) => {
    const w = new D4World();
    // A policy activation is the request Finance makes (CCP-B5, Finance → Owner); its own Finance step is refused.
    const r = w.seed('priya', 'POLICY_ACTIVATE', { payload: { policy_version_id: '019a0000-0000-7000-8000-0000000cc2a2' } });
    await expectRefused(page, w, 'priya', r.id, 'You requested this');
  });

  test('FA-7 · contracts and the audit trail are readable', async ({ page }) => {
    const w = new D4World();
    const r = w.seedEscalatedExtension(['priya']);
    w.applyAs('kwame', r);
    await as(page, w, 'priya', '/commercial/contracts');
    await expect(page.getByRole('heading', { level: 1, name: 'Contracts' })).toBeVisible();
    await as(page, w, 'priya', '/commercial/audit');
    const table = page.getByLabel('Commercial audit events');
    await expect(table.getByText('Approval step signed', { exact: true }).first()).toBeVisible();
    await expect(table.getByText('Support extension applied', { exact: true }).first()).toBeVisible();
  });
});

// ── commercial_ops ───────────────────────────────────────────────────────────

test.describe('commercial_ops', () => {
  test('CO-1 · Dashboard (no money) + rail: no Audit', async ({ page }) => {
    await as(page, new D4World(), 'tomas', '/');
    await expectRail(page, 'commercial_ops');
  });

  test('CO-2 · routes: Audit is denied in the shell, the rest open', async ({ page }) => {
    await expectRoutes(page, new D4World(), 'commercial_ops');
  });

  test('CO-3 · conversion: request → refused own approval → Finance signs → the requester applies (sent to Stripe) → audit', async ({ page }) => {
    const w = new D4World();
    await as(page, w, 'tomas', tenantPath('fernhill'));
    await signCard(page).getByRole('button', { name: 'Request conversion to MANUAL…' }).click();
    const dlg = page.getByRole('dialog', { name: 'Request conversion to MANUAL · Fernhill Studio' });
    await expect(dlg).toBeVisible();
    await dlg.getByLabel('Reason').fill('The practice is moving to a negotiated contract.');
    await dlg.getByLabel('Evidence').fill('Ticket SUP-3101');
    await dlg.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByText('Submitted for approval. Nothing applies until every step is signed and you apply it.')).toBeVisible();
    const r = w.requests.find((x) => x.action_type === 'CONVERSION');
    expect(r?.state).toBe('PENDING_APPROVAL');
    expect(r?.payload).toEqual({ direction: 'TO_GOVERNED', subscription_id: 'cb300000-0000-7000-8000-000000000055', plan_key: 'aramo-sign-starter-v1', plan_version_id: 'starter-v2' });
    expect(r?.required_chain.rule).toBe('FINANCE_ONLY');
    // Pending: no Apply yet; the requester cannot sign it.
    await expect(signCard(page).getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0);
    await expectRefused(page, w, 'tomas', r!.id, 'You requested this');
    await approveInDrawer(page, w, 'priya', r!.id, 'Finance');
    await as(page, w, 'tomas', tenantPath('fernhill'));
    const apply = signCard(page).getByRole('button', { name: 'Apply', exact: true });
    await expect(apply).toBeVisible();
    await apply.click();
    await toast(page, 'Sent to Stripe — awaiting confirmation.');
    expect(w.log).toContain(`tomas convert ${r!.id}`);
    expect(w.find(r!.id)?.state).toBe('APPLYING');
    // The audit trail (read by an audit role: commercial_ops has no audit scope).
    await as(page, w, 'ines', '/commercial/audit');
    await expect(page.getByLabel('Commercial audit events').getByText('Approval step signed', { exact: true }).first()).toBeVisible();
  });

  test('CO-4 · catalog: view only, and the ops role cannot sign a publish', async ({ page }) => {
    const w = new D4World();
    const r = w.seedTeamV3Publish();
    await as(page, w, 'tomas', catalogV3);
    await expect(page.getByRole('note').filter({ hasText: 'View only.' })).toContainText('Drafting, publishing and retiring versions needs the Catalog manager role.');
    await expectRefused(page, w, 'tomas', r.id, 'Missing the scope for this step');
  });

  test('CO-5 · support extensions are not the ops role’s: the action is disabled with its reason', async ({ page }) => {
    const w = new D4World();
    await as(page, w, 'tomas', sxFernhill);
    const btn = page.getByRole('button', { name: 'Request support extension…' });
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute('title', 'Needs the Support admin role.');
  });

  test('CO-6 · contracts: the ops role can start an amendment', async ({ page }) => {
    await as(page, new D4World(), 'tomas', '/commercial/contracts');
    await page.getByRole('button', { name: /CT-2024-007/ }).click();
    await expect(page.getByRole('button', { name: 'Record amendment…' })).toBeEnabled();
  });
});

// ── catalog_manager ──────────────────────────────────────────────────────────

test.describe('catalog_manager', () => {
  test('CM-1 · Dashboard (no money) + rail: Approvals, Catalog, Policy only (no Contracts, TD-B4-3)', async ({ page }) => {
    await as(page, new D4World(), 'lena', '/');
    await expectRail(page, 'catalog_manager');
  });

  test('CM-2 · routes: Subscriptions, Contracts, Audit and Support extensions are denied in the shell', async ({ page }) => {
    await expectRoutes(page, new D4World(), 'catalog_manager');
  });

  test('CM-3 · catalog publish: request → refused own approval → Finance → Owner → the requester applies → timeline + audit', async ({ page }) => {
    const w = new D4World();
    await as(page, w, 'lena', catalogV3);
    await page.getByRole('button', { name: 'Request publish…' }).click();
    const dlg = page.getByRole('dialog', { name: 'Request publish · Sign Team v3' });
    await dlg.getByLabel('Reason').fill('Annual price review');
    await dlg.getByLabel('Evidence').fill('PR-2026-Q4');
    await dlg.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(dlg).toBeHidden();
    await toast(page, /submitted · Finance → Owner/);
    const r = w.requests.find((x) => x.action_type === 'PLAN_VERSION_PUBLISH')!;
    expect(r.required_chain.rule).toBe('FINANCE_THEN_OWNER');
    await expect(page.getByTestId('open-request')).toContainText('is pending approval.');
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0);
    await expectRefused(page, w, 'lena', r.id, 'You requested this');
    await approveInDrawer(page, w, 'priya', r.id, 'Finance');
    await approveInDrawer(page, w, 'daniel', r.id, 'Owner');
    expect(w.find(r.id)?.state).toBe('APPROVED');
    await as(page, w, 'lena', catalogV3);
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await toast(page, /applied\.$/);
    expect(w.log).toContain(`lena apply ${r.id}`);
    await expect(page.getByRole('button', { name: /^v3/ })).toContainText('Published');
    // The drawer's timeline carries the whole trail.
    await as(page, w, 'lena', drawerPath(r.id));
    const drawer = page.getByTestId('cr-drawer');
    // CCP-UI-V12 AM-5 / D-1: the approval event names the apply deadline ("Approved · apply by …").
    for (const label of ['Submitted for approval', 'Finance step signed', 'Owner step signed', /^Approved( · .*)?$/, 'Applied']) {
      await expect(drawer.getByText(label, { exact: true }).first(), String(label)).toBeVisible();
    }
  });

  test('CM-4 · Contracts: not in the rail, and the deep link names platform:subscription:read', async ({ page }) => {
    await as(page, new D4World(), 'lena', '/commercial/contracts');
    const denied = page.getByTestId('access-denied');
    await expect(denied.getByText(whyFor('catalog_manager', 'platform:subscription:read'))).toBeVisible();
    await expect(denied.getByText('platform:subscription:read', { exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Contracts', exact: true })).toHaveCount(0);
  });
});

// ── support_admin ────────────────────────────────────────────────────────────

test.describe('support_admin', () => {
  test('SA-1 · Dashboard (no money) + rail: no Audit', async ({ page }) => {
    await as(page, new D4World(), 'kwame', '/');
    await expectRail(page, 'support_admin');
  });

  test('SA-2 · routes: Audit is denied in the shell, the rest open', async ({ page }) => {
    await expectRoutes(page, new D4World(), 'support_admin');
  });

  test('SA-3 · escalated extension: request 20 days → escalates → refused own approval → Finance signs → the requester applies', async ({ page }) => {
    const w = new D4World();
    await as(page, w, 'kwame', sxFernhill);
    await page.getByRole('button', { name: 'Request support extension…' }).click();
    const dlg = page.getByRole('dialog', { name: 'Request support extension · Fernhill Studio' });
    await dlg.getByLabel('Extension (days)').fill('20');
    await expect(dlg.getByRole('status')).toContainText('Out of bounds — escalates to approval (Finance)');
    await dlg.getByLabel('Reason').fill('The practice moved offices');
    await dlg.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByText('Escalated to Finance — nothing was applied. More than 14 days in one extension.')).toBeVisible();
    const r = w.requests.find((x) => x.action_type === 'SUPPORT_EXTENSION')!;
    expect(r.state).toBe('PENDING_APPROVAL');
    expect(r.required_chain.rule).toBe('FINANCE_ONLY');
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0);
    await expectRefused(page, w, 'kwame', r.id, 'You requested this');
    await approveInDrawer(page, w, 'priya', r.id, 'Finance');
    await as(page, w, 'kwame', sxFernhill);
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await toast(page, 'Change applied.');
    expect(w.log).toContain(`kwame apply ${r.id}`);
    expect(w.find(r.id)?.state).toBe('APPLIED');
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0);
  });

  test('SA-4 · within bounds the extension applies at once as an exception (zero approvals)', async ({ page }) => {
    const w = new D4World();
    await as(page, w, 'kwame', sxFernhill);
    await page.getByRole('button', { name: 'Request support extension…' }).click();
    const dlg = page.getByRole('dialog', { name: 'Request support extension · Fernhill Studio' });
    await expect(dlg.getByRole('status')).toContainText('Within bounds — applies now as an exception, with zero approvals');
    await dlg.getByLabel('Reason').fill('Billing contact on leave');
    await dlg.getByRole('button', { name: 'Apply extension (exception)' }).click();
    await toast(page, 'Extension applied as an exception — zero approvals, flagged in audit.');
    expect(w.audit.filter((e) => e.event_type === 'SUPPORT_EXTENSION_APPLIED').map((e) => e.is_exception)).toEqual([true]);
    expect(w.audit.filter((e) => e.event_type === 'COMMERCIAL_APPROVAL_RECORDED')).toEqual([]);
  });

  test('SA-5 · tenant isolation spot check: Fernhill’s open escalation does not show or block on Quarry Lane', async ({ page }) => {
    const w = new D4World();
    w.seedEscalatedExtension();
    await as(page, w, 'kwame', sxFernhill);
    await expect(page.getByText(/Open request/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Request support extension…' })).toBeDisabled();
    await as(page, w, 'kwame', sxQuarry);
    await expect(page.getByRole('heading', { level: 2, name: 'Aramo Sign' })).toBeVisible();
    await expect(page.getByText(/Open request/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Request support extension…' })).toBeEnabled();
  });

  test('SA-6 · conversion is not the support role’s: disabled on Tenant › Commercial', async ({ page }) => {
    await as(page, new D4World(), 'kwame', tenantPath('fernhill'));
    await expect(signCard(page).getByRole('button', { name: 'Request conversion to MANUAL…' })).toBeDisabled();
    await expect(signCard(page).getByRole('button', { name: 'Request support extension…' })).toBeEnabled();
  });
});

// ── read_only_auditor ────────────────────────────────────────────────────────

test.describe('read_only_auditor', () => {
  test('RA-1 · Dashboard (no money) + rail: every Commercial item', async ({ page }) => {
    await as(page, new D4World(), 'ines', '/');
    await expectRail(page, 'read_only_auditor');
  });

  test('RA-2 · routes: all seven Commercial screens open', async ({ page }) => {
    await expectRoutes(page, new D4World(), 'read_only_auditor');
  });

  test('RA-3 · no approval authority: every pending request is refused', async ({ page }) => {
    const w = new D4World();
    const pub = w.seedTeamV3Publish();
    const ext = w.seedEscalatedExtension();
    await expectRefused(page, w, 'ines', pub.id, 'Missing the scope for this step');
    await expectRefused(page, w, 'ines', ext.id, 'Missing the scope for this step');
  });

  test('RA-4 · view only everywhere: catalog, support extensions, Tenant › Commercial, contracts', async ({ page }) => {
    const w = new D4World();
    await as(page, w, 'ines', catalogV3);
    await expect(page.getByRole('note').filter({ hasText: 'View only.' })).toBeVisible();
    await as(page, w, 'ines', sxFernhill);
    await expect(page.getByRole('note').filter({ hasText: 'View only.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Request support extension…' })).toBeDisabled();
    await as(page, w, 'ines', tenantPath('fernhill'));
    await expect(page.getByTestId('tenant-commercial').getByRole('note')).toContainText('View only.');
    await expect(signCard(page).getByRole('button', { name: 'Request conversion to MANUAL…' })).toBeDisabled();
    await as(page, w, 'ines', '/commercial/contracts');
    const amend = page.getByRole('button', { name: 'Record amendment…' });
    await expect(amend).toHaveAttribute('aria-disabled', 'true');
    await expect(amend).toHaveAttribute('title', 'Needs the Commercial ops role.');
  });

  test('RA-5 · an approved request offers the auditor no Apply', async ({ page }) => {
    const w = new D4World();
    w.seedTeamV3Publish(['priya', 'daniel']);
    await as(page, w, 'ines', catalogV3);
    await expect(page.getByTestId('open-request')).toContainText('is approved.');
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0);
  });

  test('RA-6 · the audit trail of an applied publish, with who did what', async ({ page }) => {
    const w = new D4World();
    const r = w.seedTeamV3Publish(['priya', 'daniel']);
    w.applyAs('lena', r);
    await as(page, w, 'ines', '/commercial/audit');
    const table = page.getByLabel('Commercial audit events');
    await expect(table.getByText('Change applied', { exact: true })).toBeVisible();
    await expect(table.getByText('Approval step signed', { exact: true })).toHaveCount(2);
    for (const who of ['Lena Fischer', 'Priya Shah', 'Daniel Reyes']) await expect(table.getByText(who).first(), who).toBeVisible();
  });
});

// ── super_admin ──────────────────────────────────────────────────────────────

test.describe('super_admin', () => {
  test('SU-1 · Dashboard (no money) + rail: no Commercial group; tenant operations remain', async ({ page }) => {
    await as(page, new D4World(), 'maya', '/');
    await expectRail(page, 'super_admin');
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Tenants', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tenants' })).toBeVisible();
    await expect(page.getByTestId('access-denied')).toHaveCount(0);
  });

  test('SU-2 · routes: every Commercial deep link is the access-denied card naming no commercial authority', async ({ page }) => {
    await expectRoutes(page, new D4World(), 'super_admin');
  });

  test('SU-3 · the card names the six commercial roles; a tenant shows no Commercial tab', async ({ page }) => {
    const w = new D4World();
    await as(page, w, 'maya', '/commercial/approvals');
    const denied = page.getByTestId('access-denied');
    for (const r of ['Platform owner', 'Finance admin', 'Commercial ops', 'Catalog manager', 'Support admin', 'Read-only auditor']) await expect(denied.getByText(r, { exact: true })).toBeVisible();
    await expect(denied.getByRole('button', { name: 'Back to dashboard' })).toBeVisible();
    await as(page, w, 'maya', `/tenants/${B3_TENANTS.fernhill}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Fernhill Studio' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Commercial' })).toHaveCount(0);
    expect(w.log).toEqual([]);
  });
});
