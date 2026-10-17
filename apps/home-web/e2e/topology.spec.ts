import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page, type Route } from '@playwright/test';

// D-ORG Gate-6 V3 — the integrated tenant-host bundle in a real browser (see the
// config header for what is real and what is stubbed). Every scenario saves a
// full-page screenshot under e2e/.evidence (gitignored; copied into the evidence
// bundle by the Executor).

const EVIDENCE = resolve(__dirname, '.evidence');
mkdirSync(EVIDENCE, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(EVIDENCE, `${name}.png`), fullPage: true });

const TENANT = '01900000-0000-7000-8000-000000000001';
const NOW = Math.floor(Date.now() / 1000);
const ORG_SCOPES = ['auth:session:read', 'tenant:admin:profile', 'tenant:admin:domain', 'tenant:admin:sites', 'tenant:admin:user-manage', 'tenant:admin:settings', 'tenant:user:read:directory', 'audit:read'];
const ATS_SCOPES = ['auth:session:read', 'dashboard:read', 'requisition:read', 'talent:read', 'company:read', 'contact:read', 'pipeline:read', 'tenant:admin:settings', 'tenant:admin:user-manage'];

interface Jar {
  org: boolean;
  recruiter: boolean;
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// The stubbed backends. `jar` models which consumer sessions "exist" (the real
// cookies are HttpOnly and set by auth-service; here the session probe answers
// from the model). Captures the consumer header each SPA sends on /v1 reads.
async function stubBackends(page: Page, jar: Jar, seen: { consumerHeaders: Set<string>; loginUrls: string[] }) {
  await page.route('**/auth/**', async (route) => {
    const url = new URL(route.request().url());
    const m = /^\/auth\/([a-z]+)\/(session|login|logout|refresh)$/.exec(url.pathname);
    if (!m) return json(route, { error: { code: 'NOT_FOUND' } }, 404);
    const [, consumer, op] = m as unknown as [string, 'org' | 'recruiter' | 'esign', string];
    if (op === 'session') {
      if (!jar[consumer as keyof Jar]) return json(route, { error: { code: 'AUTH_REQUIRED' } }, 401);
      return json(route, { sub: 'user-1', consumer_type: consumer, tenant_id: TENANT, scopes: consumer === 'org' ? ORG_SCOPES : ATS_SCOPES, iat: NOW, exp: NOW + 900 });
    }
    if (op === 'login') {
      seen.loginUrls.push(url.pathname + url.search);
      // The real auth-service 302s to Cognito and back; the stub "signs in" the
      // consumer and lands exactly where the real callback would (return_to or the
      // consumer's app base).
      if (consumer === 'recruiter' || consumer === 'org') jar[consumer] = true;
      const rt = url.searchParams.get('return_to');
      const landing = rt ?? (consumer === 'recruiter' ? '/ats/' : '/');
      return route.fulfill({ status: 302, headers: { location: landing } });
    }
    if (op === 'logout') {
      if (route.request().method() === 'POST') { jar[consumer as keyof Jar] = false; return route.fulfill({ status: 204 }); }
      // GET = the global browser sign-out → Cognito → /signed-out.
      jar.org = false; jar.recruiter = false;
      return route.fulfill({ status: 302, headers: { location: '/signed-out' } });
    }
    return json(route, { error: { code: 'NOT_FOUND' } }, 404);
  });
  await page.route('**/v1/**', async (route) => {
    const req = route.request();
    const h = req.headers()['x-aramo-consumer'];
    if (h) seen.consumerHeaders.add(h);
    const path = new URL(req.url()).pathname;
    if (path === '/v1/me') return json(route, { user: { display_name: 'Priya Nair', email: 'priya@acme.test' }, roles: ['Tenant Owner', 'Recruiter'], tenant: { display_name: 'Acme Staffing', status: 'ACTIVE' } });
    if (path === '/v1/me/products') return json(route, { tenant_id: TENANT, products: [
      { key: 'ats', subscribed: true, authorized: true, available: true, entry_path: '/ats/', reason: null },
      { key: 'esign', subscribed: true, authorized: false, available: false, entry_path: null, reason: 'not_authorized' },
      { key: 'org', subscribed: true, authorized: true, available: true, entry_path: '/org/', reason: null },
    ] });
    if (path === '/v1/tenant/users') return json(route, { items: [
      { user_id: 'u-1', email: 'priya@acme.test', display_name: 'Priya Nair', is_active: true, invite_status: 'ACTIVE', deactivated_at: null, site_id: null, role_keys: ['tenant_owner'] },
      { user_id: 'u-2', email: 'sam@acme.test', display_name: 'Sam Lee', is_active: true, invite_status: 'INVITED', deactivated_at: null, site_id: null, role_keys: ['recruiter'] },
    ] });
    if (path === '/v1/tenant/roles-catalog') return json(route, { roles: [
      { key: 'tenant_owner', display: 'Tenant Owner', description: 'Owns the organization.', tier: 'tenant', scopes: ORG_SCOPES },
      { key: 'recruiter', display: 'Recruiter', description: 'Works requisitions and talent.', tier: 'ats', scopes: ['talent:read', 'requisition:read'] },
      { key: 'org_admin', display: 'Organization Admin', description: 'Administers the organization.', tier: 'tenant', scopes: ORG_SCOPES },
    ] });
    if (path === '/v1/tenant/settings') return json(route, { 'compensation.display_default': 'both', 'audit.financials_enabled': true });
    if (path === '/v1/tenant/profile') return json(route, { id: TENANT, name: 'Acme Staffing', legal_name: 'Acme Staffing Inc.', display_name: 'Acme Staffing', address_line1: '1 Main St', address_line2: null, city: 'Austin', state_province: 'TX', postal_code: '78701', country_code: 'US', tax_id: null, registration_number: null, primary_contact_name: 'Priya Nair', primary_contact_email: 'priya@acme.test', updated_at: new Date().toISOString() });
    if (path === '/v1/tenant/sites') return json(route, { items: [] });
    if (path === '/v1/tenant/audit-events') return json(route, { items: [], next_cursor: null });
    if (path === '/v1/tenant/domain-verification') return json(route, { status: 'UNVERIFIED', allowed_domain: 'acme.test', record_name: '_aramo.acme.test', record_value: 'aramo-verify=abc', verified_at: null, token_issued_at: new Date().toISOString() });
    if (path === '/v1/my-desk') return json(route, { generated_at: new Date().toISOString(), server_date: new Date().toISOString().slice(0, 10), priority_items: [], interviews_today: [], awaiting_client: [], exceptions: [], requisitions: [] });
    return json(route, { items: [] });
  });
}

test.describe('D-ORG topology T1 on the integrated nginx bundle', () => {
  test('unauthenticated tenant root → the org consumer login (no return_to for the root); App Home renders after sign-in; the ATS tile enters through the recruiter login with return_to=/ats/', async ({ page }) => {
    const jar: Jar = { org: false, recruiter: false };
    const seen = { consumerHeaders: new Set<string>(), loginUrls: [] as string[] };
    await stubBackends(page, jar, seen);
    await page.goto('/');
    await expect(page.getByTestId('home-tiles')).toBeVisible();
    expect(seen.loginUrls[0]).toBe('/auth/org/login');
    await expect(page.getByTestId('home-tile-ats')).toHaveAttribute('href', '/auth/recruiter/login?return_to=%2Fats%2F');
    await expect(page.getByTestId('home-tile-esign')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('Acme Staffing')).toBeVisible();
    await shot(page, '01-app-home');
    expect(seen.consumerHeaders.has('org')).toBe(true);
    expect(seen.consumerHeaders.has('recruiter')).toBe(false);

    await page.getByTestId('home-tile-ats').click();
    await page.waitForURL(/\/ats\/?$/);
    expect(seen.loginUrls.at(-1)).toBe('/auth/recruiter/login?return_to=%2Fats%2F');
    await expect(page.locator('#rc-main-content')).toBeVisible();
    await shot(page, '02-ats-after-tile');
    expect(seen.consumerHeaders.has('recruiter')).toBe(true);
    // The org session is still present while the ATS is open (coexistence at the FE boundary).
    expect(jar.org).toBe(true);
  });

  test('ATS deep link + browser refresh through nginx; the ATS settings rail links OUT to /org/ with a host-level anchor; Organization Administration renders the relocated views', async ({ page }) => {
    const jar: Jar = { org: true, recruiter: true };
    const seen = { consumerHeaders: new Set<string>(), loginUrls: [] as string[] };
    await stubBackends(page, jar, seen);
    await page.goto('/ats/admin/settings/recruiting');
    await expect(page.getByRole('heading', { name: /recruiting settings/i })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: /recruiting settings/i })).toBeVisible();
    await shot(page, '03-ats-settings-recruiting');
    const org = page.getByTestId('settings-nav-organization');
    await expect(org).toHaveAttribute('href', '/org/');
    await org.click();
    await page.waitForURL(/\/org\/profile$/);
    await expect(page.getByRole('heading', { name: 'Organization profile' })).toBeVisible();
    await expect(page.getByLabel(/legal name/i)).toHaveValue('Acme Staffing Inc.');
    await shot(page, '04-org-profile');
    await page.goto('/org/users');
    await page.reload();
    await expect(page.getByText('priya@acme.test')).toBeVisible();
    await shot(page, '05-org-users');
    await page.getByRole('button', { name: /invite/i }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').getByText('Recruiter')).toBeVisible();
    await shot(page, '06-org-invite-dialog');
    await page.keyboard.press('Escape');
    await page.goto('/org/roles');
    await expect(page.getByRole('heading', { name: 'Roles & permissions' })).toBeVisible();
    await shot(page, '07-org-roles');
    await page.goto('/org/audit');
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    await shot(page, '08-org-audit');
    await page.goto('/org/sites');
    await expect(page.getByRole('heading', { name: 'Sites & branches' })).toBeVisible();
    await shot(page, '09-org-sites');
    // Back to the App Home from the organization rail.
    await page.getByTestId('org-nav-home').click();
    await page.waitForURL(/\/$/);
    await expect(page.getByTestId('home-tiles')).toBeVisible();
  });

  test('a pre-T1 ATS bookmark on the tenant host is forwarded to /ats/<path> with the query preserved, before any login', async ({ page }) => {
    const jar: Jar = { org: false, recruiter: true };
    const seen = { consumerHeaders: new Set<string>(), loginUrls: [] as string[] };
    await stubBackends(page, jar, seen);
    await page.goto('/requisitions/r-1?tab=pipeline');
    await page.waitForURL(/\/ats\/requisitions\/r-1\?tab=pipeline$/);
    expect(seen.loginUrls.filter((u) => u.startsWith('/auth/org/'))).toEqual([]);
    await shot(page, '10-legacy-bookmark-forwarded');
  });

  test('an org session alone never opens the ATS: /ats/ sends the browser to the recruiter login (cross-consumer refusal at the FE boundary)', async ({ page }) => {
    const jar: Jar = { org: true, recruiter: false };
    const seen = { consumerHeaders: new Set<string>(), loginUrls: [] as string[] };
    await stubBackends(page, jar, seen);
    // Make the recruiter login NOT sign in (so we observe the redirect itself).
    // Registered AFTER the generic stubs: Playwright matches the most recently
    // registered route first.
    await page.route('**/auth/recruiter/login*', (route) => { seen.loginUrls.push(new URL(route.request().url()).pathname); return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>recruiter login stub</h1>' }); });
    await page.goto('/ats/');
    await expect(page.getByText('recruiter login stub')).toBeVisible();
    expect(seen.loginUrls).toContain('/auth/recruiter/login');
  });

  test('login error landings and the signed-out landing render session-less in BOTH apps', async ({ page }) => {
    const jar: Jar = { org: false, recruiter: false };
    const seen = { consumerHeaders: new Set<string>(), loginUrls: [] as string[] };
    await stubBackends(page, jar, seen);
    await page.goto('/login?error=TENANT_CAPABILITY_NOT_ENTITLED');
    await expect(page.getByText('Organization not available')).toBeVisible();
    await shot(page, '11-home-login-not-entitled');
    await page.goto('/ats/login?error=TENANT_CAPABILITY_NOT_ENTITLED');
    await expect(page.getByText('Product not available')).toBeVisible();
    await expect(page.getByTestId('login-open-app-home')).toHaveAttribute('href', '/');
    await shot(page, '12-ats-login-not-entitled');
    await page.goto('/signed-out');
    await expect(page.getByText(/you're signed out/i)).toBeVisible();
    await shot(page, '13-home-signed-out');
    await page.goto('/ats/signed-out');
    await expect(page.getByText(/you're signed out/i)).toBeVisible();
    await shot(page, '14-ats-signed-out');
    expect(seen.loginUrls).toEqual([]);
  });

  test('sign-out from the App Home is the global browser sign-out: both consumer sessions end and the browser lands on /signed-out', async ({ page }) => {
    const jar: Jar = { org: true, recruiter: true };
    const seen = { consumerHeaders: new Set<string>(), loginUrls: [] as string[] };
    await stubBackends(page, jar, seen);
    await page.goto('/');
    await expect(page.getByTestId('home-tiles')).toBeVisible();
    await page.getByRole('button', { name: /account/i }).click();
    await page.getByRole('menuitem', { name: /sign out/i }).click();
    await page.waitForURL(/\/signed-out$/);
    await expect(page.getByText(/you're signed out/i)).toBeVisible();
    expect(jar).toEqual({ org: false, recruiter: false });
    await shot(page, '15-global-sign-out');
  });
});
