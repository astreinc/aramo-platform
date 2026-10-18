import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page, type Route } from '@playwright/test';

// Unified multi-product UX — browser verification of the INTEGRATED tenant-host
// bundle: the real nginx front-door image (deploy/nginx/Dockerfile — five baked
// SPAs + the real aramo.conf.template) in a real Chromium. Backends are stubbed at
// the browser network layer with the documented response shapes (config header);
// backend contracts are proven by the auth-service / identity integration suites.
// Every scenario writes screenshots under e2e/.evidence (gitignored).

const EVIDENCE = resolve(__dirname, '.evidence');
mkdirSync(EVIDENCE, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(EVIDENCE, `${name}.png`) });

const TENANT = '01900000-0000-7000-8000-000000000001';
const NOW = Math.floor(Date.now() / 1000);
const ORG_ADMIN_SCOPES = ['auth:session:read', 'tenant:admin:profile', 'tenant:admin:domain', 'tenant:admin:sites', 'tenant:admin:user-manage', 'tenant:admin:settings', 'tenant:user:read:directory', 'audit:read'];
const ATS_SCOPES = ['auth:session:read', 'dashboard:read', 'requisition:read', 'talent:read', 'company:read', 'contact:read', 'pipeline:read', 'tenant:admin:settings', 'tenant:admin:user-manage', 'audit:read'];

interface Jar {
  org: boolean;
  recruiter: boolean;
  orgAdmin: boolean;
}
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const USERS = [
  { user_id: 'u-1', email: 'purush@acme.test', display_name: 'Purush Pichaimuthu', is_active: true, invite_status: 'ACTIVE', deactivated_at: null, site_id: null, role_keys: ['org_admin'] },
  { user_id: 'u-2', email: 'deepika@acme.test', display_name: 'Deepika Rao', is_active: true, invite_status: 'ACTIVE', deactivated_at: null, site_id: null, role_keys: ['recruiter'] },
  { user_id: 'u-3', email: 'tom@acme.test', display_name: 'Tom Reed', is_active: true, invite_status: 'INVITED', deactivated_at: null, site_id: null, role_keys: ['recruiter'] },
];
const CATALOG = [
  { key: 'org_admin', display: 'Organization Admin', description: 'Administers the organization.', tier: 'Administration', scopes: ORG_ADMIN_SCOPES },
  { key: 'tenant_admin', display: 'Tenant Admin', description: 'Administrative operator of the tenant.', tier: 'Administration', scopes: ['tenant:admin:settings', 'talent:read'] },
  { key: 'recruiter', display: 'Recruiter', description: 'Works requisitions and talent.', tier: 'Operations', scopes: ['talent:read', 'requisition:read'] },
  { key: 'esign_sender', display: 'Sign Sender', description: 'Sends documents for signature.', tier: 'E-Sign', scopes: ['esign:envelope:send'] },
];

async function stubBackends(page: Page, jar: Jar, seen: { consumerHeaders: Set<string>; loginUrls: string[] }) {
  await page.route('**/auth/**', async (route) => {
    const url = new URL(route.request().url());
    const m = /^\/auth\/([a-z]+)\/(session|login|logout|refresh)$/.exec(url.pathname);
    if (!m) return json(route, { error: { code: 'NOT_FOUND' } }, 404);
    const consumer = m[1] as 'org' | 'recruiter';
    const op = m[2];
    if (op === 'session') {
      if (!jar[consumer]) return json(route, { error: { code: 'AUTH_REQUIRED' } }, 401);
      const scopes = consumer === 'org' ? (jar.orgAdmin ? ORG_ADMIN_SCOPES : ['auth:session:read']) : ATS_SCOPES;
      return json(route, { sub: 'user-1', consumer_type: consumer, tenant_id: TENANT, scopes, iat: NOW, exp: NOW + 900 });
    }
    if (op === 'login') {
      seen.loginUrls.push(url.pathname + url.search);
      jar[consumer] = true;
      const rt = url.searchParams.get('return_to');
      return route.fulfill({ status: 302, headers: { location: rt ?? (consumer === 'recruiter' ? '/ats/' : '/') } });
    }
    if (op === 'logout') {
      if (route.request().method() === 'POST') {
        jar[consumer] = false;
        return route.fulfill({ status: 204 });
      }
      jar.org = false;
      jar.recruiter = false;
      return route.fulfill({ status: 302, headers: { location: '/signed-out' } });
    }
    return json(route, {}, 404);
  });
  await page.route('**/v1/**', async (route) => {
    const req = route.request();
    const h = req.headers()['x-aramo-consumer'];
    if (h) seen.consumerHeaders.add(h);
    const path = new URL(req.url()).pathname;
    if (path === '/v1/me') return json(route, { user: { display_name: 'Purush Pichaimuthu', email: 'purush@acme.test' }, roles: ['Organization Admin', 'Recruiter'], tenant: { display_name: 'Astre Consulting', status: 'ACTIVE' } });
    if (path === '/v1/me/products')
      return json(route, {
        tenant_id: TENANT,
        products: [
          { key: 'ats', subscribed: true, authorized: true, available: true, entry_path: '/ats/', reason: null },
          { key: 'esign', subscribed: false, authorized: false, available: false, entry_path: null, reason: 'not_subscribed' },
          { key: 'org', subscribed: true, authorized: jar.orgAdmin, available: jar.orgAdmin, entry_path: jar.orgAdmin ? '/org/' : null, reason: jar.orgAdmin ? null : 'not_authorized' },
        ],
      });
    if (path === '/v1/tenant/users') return json(route, { items: USERS });
    if (path === '/v1/tenant/roles-catalog') return json(route, { roles: CATALOG });
    if (path === '/v1/tenant/settings') return json(route, { 'compensation.display_default': 'both', 'audit.financials_enabled': true });
    if (path === '/v1/tenant/profile') return json(route, { id: TENANT, name: 'Astre Consulting', legal_name: 'Astre Consulting Services Inc.', display_name: 'Astre Consulting', address_line1: '1 Bridge Plaza', address_line2: null, city: 'Fort Lee', state_province: 'NJ', postal_code: '07024', country_code: 'US', tax_id: null, registration_number: null, primary_contact_name: 'Purush Pichaimuthu', primary_contact_email: 'purush@acme.test', updated_at: new Date().toISOString() });
    if (path === '/v1/tenant/sites') return json(route, { items: [] });
    if (path === '/v1/tenant/audit-events') return json(route, { items: [], next_cursor: null });
    if (path === '/v1/tenant/domain-verification') return json(route, { status: 'UNVERIFIED', allowed_domain: 'acme.test', record_name: '_aramo.acme.test', record_value: 'aramo-verify=abc', verified_at: null, token_issued_at: new Date().toISOString() });
    if (path === '/v1/my-desk') return json(route, { generated_at: new Date().toISOString(), server_date: new Date().toISOString().slice(0, 10), priority_items: [], interviews_today: [], awaiting_client: [], exceptions: [], requisitions: [] });
    return json(route, { items: [] });
  });
}

function fresh(orgAdmin = true) {
  return { jar: { org: false, recruiter: false, orgAdmin } as Jar, seen: { consumerHeaders: new Set<string>(), loginUrls: [] as string[] } };
}

test.describe('unified multi-product experience on the integrated nginx bundle', () => {
  test('App Home: shared rail + switcher + account menu; organization admin tiles; ATS opens at /ats/ through its own login', async ({ page }) => {
    const { jar, seen } = fresh();
    await stubBackends(page, jar, seen);
    await page.goto('/');
    await expect(page.getByTestId('home-tiles')).toBeVisible();
    expect(seen.loginUrls[0]).toBe('/auth/org/login');
    await expect(page.getByRole('complementary', { name: 'Main navigation' })).toBeVisible();
    await expect(page.getByTestId('home-org-tiles')).toBeVisible();
    await expect(page.getByTestId('home-other-esign')).toContainText('Not subscribed');
    await shot(page, '01-app-home-1440');
    await page.getByRole('button', { name: 'Switch application' }).click();
    await expect(page.getByTestId('app-switch-home')).toContainText('You are here');
    await expect(page.getByTestId('app-switch-ats')).toHaveAttribute('href', '/ats/');
    await expect(page.getByTestId('app-switch-sign')).toHaveAttribute('aria-disabled', 'true');
    await shot(page, '02-app-switcher');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Account/ }).click();
    await expect(page.getByRole('menuitem', { name: /My preferences/ })).toBeVisible();
    await expect(page.getByRole('menu').getByText('ADMIN', { exact: true })).toBeVisible();
    await shot(page, '03-account-menu');
    await page.keyboard.press('Escape');
    await page.getByTestId('home-open-ats').click();
    await page.waitForURL(/\/ats\/?$/);
    // The tile opens the product's entry path; the ATS's own guard then runs ITS
    // consumer login (the app root needs no return_to).
    await expect(page.locator('#rc-main-content')).toBeVisible();
    await expect.poll(() => seen.loginUrls).toContain('/auth/recruiter/login');
    await page.getByRole('button', { name: 'Switch application' }).click();
    await expect(page.getByTestId('app-switch-ats')).toContainText('You are here');
    await expect(page.getByTestId('app-switch-home')).toHaveAttribute('href', '/');
    await shot(page, '04-ats-switcher');
    expect(jar.org).toBe(true);
    expect(seen.consumerHeaders.has('org')).toBe(true);
    expect(seen.consumerHeaders.has('recruiter')).toBe(true);
  });

  test('ATS Settings → Organization with exact-page return: Teams → Open Sites → Back to ATS Settings; roles reference → Manage user access', async ({ page }) => {
    const { jar, seen } = fresh();
    jar.org = true;
    jar.recruiter = true;
    await stubBackends(page, jar, seen);
    await page.goto('/ats/admin/settings/branches');
    await expect(page.getByRole('heading', { name: 'Teams & reporting hierarchy' })).toBeVisible();
    await shot(page, '05-ats-teams-hierarchy');
    await page.getByTestId('branches-sites-link').click();
    await page.waitForURL(/\/org\/sites\?from=ats&return=/);
    await expect(page.getByTestId('org-back-link')).toHaveText('← Back to ATS Settings');
    await shot(page, '06-org-sites-with-back');
    // The return context survives a tab switch, then returns to the exact page.
    await page.getByTestId('org-nav-users').click();
    await expect(page.getByRole('heading', { name: 'Users & invitations' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Sign' })).toBeVisible();
    await shot(page, '07-org-users-invitations');
    await page.getByTestId('org-back-link').click();
    await page.waitForURL(/\/ats\/admin\/settings\/branches$/);
    await page.goto('/ats/admin/settings/roles');
    await expect(page.getByRole('heading', { name: 'ATS roles & permissions' })).toBeVisible();
    await expect(page.getByText('Read-only reference')).toBeVisible();
    await expect(page.getByText('Sign Sender')).toHaveCount(0);
    await shot(page, '08-ats-roles-reference');
    await page.getByTestId('ats-roles-manage-access').click();
    await page.waitForURL(/\/org\/roles\?from=ats/);
    await expect(page.getByRole('heading', { name: 'Users & product access' })).toBeVisible();
    await shot(page, '09-org-product-access');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Users & product access' })).toBeVisible();
  });

  test('ATS Settings rail and the ORGANIZATION · SHARED link at 1920 wide', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const { jar, seen } = fresh();
    jar.org = true;
    jar.recruiter = true;
    await stubBackends(page, jar, seen);
    await page.goto('/ats/admin/settings/recruiting');
    await expect(page.getByTestId('settings-nav-organization')).toHaveAttribute('href', /\/org\/profile\?from=ats&return=%2Fats%2Fadmin%2Fsettings%2Frecruiting/);
    await shot(page, '10-ats-settings-1920');
    await page.goto('/');
    await expect(page.getByTestId('home-tiles')).toBeVisible();
    await shot(page, '11-app-home-1920');
  });

  test('a member without organization rights is refused safely: /org/* → App Home with the denial message; no Organization tile or rail item', async ({ page }) => {
    const { jar, seen } = fresh(false);
    jar.org = true;
    await stubBackends(page, jar, seen);
    await page.goto('/org/users');
    await page.waitForURL(/\/\?notice=org-denied$/);
    await expect(page.getByTestId('home-org-denied')).toContainText('Organization administration needs the organization admin role');
    await expect(page.getByTestId('home-org-tiles')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Organization' })).toHaveCount(0);
    await shot(page, '12-org-denied');
  });

  test('legacy ATS organization pages redirect once to Organization administration', async ({ page }) => {
    const { jar, seen } = fresh();
    jar.org = true;
    jar.recruiter = true;
    await stubBackends(page, jar, seen);
    await page.goto('/ats/admin/users');
    await page.waitForURL(/\/org\/users\?from=ats&return=/);
    await expect(page.getByRole('heading', { name: 'Users & invitations' })).toBeVisible();
    await page.goto('/ats/admin/settings/profile');
    await page.waitForURL(/\/org\/profile\?from=ats/);
    await page.goto('/requisitions/r-1?tab=pipeline');
    await page.waitForURL(/\/ats\/requisitions\/r-1\?tab=pipeline$/);
  });

  test('My preferences: shared account read-only + default landing page as an honest seam (nothing saved)', async ({ page }) => {
    const { jar, seen } = fresh();
    jar.org = true;
    await stubBackends(page, jar, seen);
    await page.goto('/preferences');
    await expect(page.getByTestId('prefs-account')).toContainText('purush@acme.test');
    await expect(page.getByTestId('prefs-landing')).toContainText('Coming soon');
    await expect(page.getByRole('button', { name: /Save/ })).toHaveCount(0);
    await shot(page, '13-preferences');
  });

  test('one collapse preference across apps: collapse on App Home, the ATS opens collapsed', async ({ page }) => {
    const { jar, seen } = fresh();
    jar.org = true;
    jar.recruiter = true;
    await stubBackends(page, jar, seen);
    await page.goto('/');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await page.goto('/ats/');
    await expect(page.getByRole('button', { name: 'Open sidebar' })).toBeVisible();
    await shot(page, '14-ats-collapsed-after-home');
  });

  test('sign-out from either app ends both sessions and lands on /signed-out', async ({ page }) => {
    const { jar, seen } = fresh();
    jar.org = true;
    jar.recruiter = true;
    await stubBackends(page, jar, seen);
    await page.goto('/ats/');
    await page.getByRole('button', { name: /Account/ }).click();
    await page.getByRole('menuitem', { name: /Sign out/ }).click();
    await page.waitForURL(/\/signed-out$/);
    expect(jar).toMatchObject({ org: false, recruiter: false });
  });
});

// ── The external signer app on its own host (sign.<host>) ──────────────────────
const SIGN = process.env['DORG_E2E_SIGN_URL'] ?? 'https://sign.localhost:8443';

test.describe('signer app (sign host) — reached only through a signing link', () => {
  async function stubSigning(page: Page, exchangeCode?: string) {
    await page.route('**/v1/esign/signing/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace('/v1/esign/signing/', '');
      if (path === 'exchange') {
        return exchangeCode
          ? json(route, { error: { code: exchangeCode } }, exchangeCode === 'ENVELOPE_ALREADY_EXECUTED' ? 409 : 401)
          : json(route, { session_id: 's1', envelope_id: 'e1', signer_id: 'g1' });
      }
      if (path === 'disclosure') return json(route, { accepted: true });
      if (path === 'document')
        return json(route, {
          documents: [{ document_id: 'd1', title: 'Right to Represent — Business Analyst, Unisys', ordinal: 1 }],
          fields: [
            { field_id: 'f1', document_id: 'd1', field_type: 'INITIALS', page_number: 1, x: 1, y: 1, width: 1, height: 1, required: true },
            { field_id: 'f2', document_id: 'd1', field_type: 'SIGNATURE', page_number: 2, x: 1, y: 1, width: 1, height: 1, required: true },
            { field_id: 'f3', document_id: 'd1', field_type: 'SIGN_DATE', page_number: 2, x: 1, y: 2, width: 1, height: 1, required: true },
          ],
        });
      if (path === 'source') {
        const pdf = '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
        return json(route, { source_base64: Buffer.from(pdf).toString('base64'), content_type: 'application/pdf' });
      }
      if (path.startsWith('fields/')) return json(route, { filled: true });
      if (path === 'complete') return json(route, { envelope_status: 'IN_PROGRESS' });
      if (path === 'decline') return json(route, { declined: true });
      return json(route, {}, 404);
    });
  }

  test('landing → disclosure → workspace → adopt → finish; no navigation into Aramo anywhere', async ({ page }) => {
    await stubSigning(page);
    await page.goto(`${SIGN}/s/tok-abc`);
    await expect(page.getByTestId('sg-landing')).toBeVisible();
    await expect(page.locator('a')).toHaveCount(0);
    await shot(page, '20-signer-landing');
    await page.getByRole('button', { name: 'Review document' }).click();
    await expect(page.getByRole('button', { name: 'Agree & continue' })).toBeDisabled();
    await shot(page, '21-signer-disclosure');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Agree & continue' }).click();
    await expect(page.getByTestId('sg-workspace')).toBeVisible();
    await shot(page, '22-signer-workspace');
    await page.getByRole('button', { name: 'Start' }).click();
    await page.getByRole('textbox', { name: 'Your initials' }).fill('RS');
    await shot(page, '23-signer-adopt');
    await page.getByRole('button', { name: 'Adopt & initial' }).click();
    await page.getByRole('button', { name: 'Next field' }).click();
    await page.getByRole('textbox', { name: 'Your full name' }).fill('Ravi Shankar');
    await page.getByRole('button', { name: 'Adopt & sign' }).click();
    await page.getByRole('button', { name: 'Next field' }).click();
    await page.getByRole('button', { name: 'Review & finish' }).click();
    await page.getByRole('button', { name: 'Finish signing' }).click();
    await expect(page.getByText(/Others still need to sign/)).toBeVisible();
    await expect(page.locator('a')).toHaveCount(0);
    await shot(page, '24-signer-done-others-pending');
  });

  test('mobile 390: landing and workspace stack, no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubSigning(page);
    await page.goto(`${SIGN}/s/tok-abc`);
    await page.getByRole('button', { name: 'Review document' }).click();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Agree & continue' }).click();
    await expect(page.getByTestId('sg-workspace')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, '25-signer-mobile-workspace');
  });

  test('token states: invalid, expired/used, ended — each its own screen; /s/ without a token is Invalid link', async ({ page }) => {
    for (const [code, heading, name] of [
      ['SIGNING_SESSION_INVALID', "This signing link isn't valid", '26-signer-invalid'],
      ['SIGNING_SESSION_EXPIRED', 'This link is no longer active', '27-signer-expired'],
      ['ENVELOPE_ALREADY_EXECUTED', 'This document is no longer available to sign', '28-signer-ended'],
    ] as const) {
      await page.unrouteAll();
      await stubSigning(page, code);
      await page.goto(`${SIGN}/s/tok-${code}`);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await expect(page.locator('a')).toHaveCount(0);
      await shot(page, name);
    }
    await page.goto(`${SIGN}/s/`);
    await expect(page.getByRole('heading', { name: "This signing link isn't valid" })).toBeVisible();
  });
});
