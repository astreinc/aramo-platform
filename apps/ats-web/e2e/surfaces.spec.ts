import { expect, test, type Page } from '@playwright/test';

// LIVE surface walk — runs against the REAL stack (apps/api + auth-service) with
// a genuine recruiter session (auth.setup.ts). Resilient to real-tenant data:
// lists may be empty, so each surface asserts "content OR honest empty state",
// never a hard-coded fixture row. The four things harnesses cannot catch
// (Lead step 2) are checked here: RouteGuard scope-gating, ID→name resolution
// without an N+1 storm or UUID leakage, empty/loading/error under real latency,
// and real response-shape drift (surfaced as console/page errors).

const FULL_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Console / page errors are shape-drift canaries — a real response the FE
// mis-renders throws here. Benign network noise (favicon, etc.) is filtered.
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|404 \(Not Found\)/i.test(m.text())) {
      errors.push(`console: ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test.describe.serial('ats-web live surfaces', () => {
  test('shell + My desk renders with resolved names (no UUID leak, no N+1 storm)', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    const v1Requests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/v1/')) v1Requests.push(r.url());
    });

    await page.goto('/');
    // Shell chrome.
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Log out/ })).toBeVisible();
    // My desk landing (recruiter has dashboard:read) OR the requisitions
    // fallback (no dashboard:read) — both are valid, neither may error.
    await expect(
      page.getByRole('heading', { name: /My desk|Requisitions/ }).first(),
    ).toBeVisible();

    // Give the parallel resolutions a beat to settle, then assert no raw UUID
    // surfaced in the rendered surface (company/owner ids resolved to names).
    await page.waitForTimeout(1500);
    const bodyText = (await page.locator('main, .rc-content').first().innerText()) ?? '';
    expect(bodyText).not.toMatch(FULL_UUID);

    // Bounded fan-out: My desk is 4 fixed fetches (+ session). An ID→name N+1
    // storm would be dozens of per-row company/owner fetches.
    expect(v1Requests.length).toBeLessThan(20);
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  test('Requisitions list: renders, no UUID leak, row → detail (header/meta/tabs/breadcrumb)', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await page.goto('/requisitions');
    await expect(page.getByRole('heading', { name: 'Requisitions' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'All' })).toBeVisible();

    const tableText = (await page.locator('.rc-tablewrap, main').first().innerText()) ?? '';
    expect(tableText).not.toMatch(FULL_UUID);

    // If the test tenant has at least one visible requisition, drill into it and
    // validate the 2D detail under real data; otherwise assert the empty state.
    const firstReqLink = page.locator('.rc-table tbody a.rc-link-strong').first();
    if ((await firstReqLink.count()) > 0) {
      const title = (await firstReqLink.innerText()).trim();
      await firstReqLink.click();
      // Header + meta + tabs.
      await expect(page.locator('.rc-dhead__title')).toBeVisible();
      await expect(page.locator('.rc-meta')).toBeVisible();
      await expect(page.getByRole('tab', { name: /Pipeline/ })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'Details' })).toBeVisible();
      // Funnel ribbon.
      await expect(page.getByText('This req at a glance')).toBeVisible();
      // Entity breadcrumb published.
      const crumb = page.getByRole('navigation', { name: 'Breadcrumb' });
      await expect(crumb).toContainText('Requisitions');
      if (title.length > 0) await expect(crumb).toContainText(title.split('\n')[0]!.trim());
      // Details tab reveals the cockpit.
      await page.getByRole('tab', { name: 'Details' }).click();
      await expect(page.getByText('Identity')).toBeVisible();
    } else {
      await expect(
        page.getByText(/No requisitions (visible to you yet|match these filters)/),
      ).toBeVisible();
    }
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  test('Talent list: pool framing + refusal-layer footer, no UUID leak', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await page.goto('/talent');
    await expect(page.getByRole('heading', { name: 'Talent' })).toBeVisible();
    await expect(page.getByText(/tenant talent pool/i)).toBeVisible();
    // G3 refusal layer.
    await expect(
      page.getByText(/open-web talent search or bulk export/i),
    ).toBeVisible();
    const text = (await page.locator('main').innerText()) ?? '';
    expect(text).not.toMatch(FULL_UUID);
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  test('Companies list renders (company:read)', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/companies');
    // The companies surface (existing) renders a heading; assert no error +
    // no crash regardless of row count.
    await expect(page.locator('main')).toBeVisible();
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  test('RouteGuard scope-gating: nav reflects held scopes; an unheld route shows ForbiddenState', async ({
    page,
  }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav).toBeVisible();

    // Data-driven ForbiddenState check (the "cheaply possible" path): if the
    // test recruiter lacks a nav scope (the item is absent), navigating to that
    // route directly must render ForbiddenState — proving the guard still bites.
    const gated: Array<{ label: string; path: string }> = [
      { label: 'Tasks', path: '/tasks' },
      { label: 'Companies', path: '/companies' },
      { label: 'Talent', path: '/talent' },
    ];
    let asserted = false;
    for (const g of gated) {
      const present = (await nav.getByRole('link', { name: g.label }).count()) > 0;
      if (!present) {
        await page.goto(g.path);
        await expect(
          page.getByText(/don.?t have access|forbidden|not authorized/i),
        ).toBeVisible();
        asserted = true;
        break;
      }
    }
    if (!asserted) {
      test.info().annotations.push({
        type: 'note',
        description:
          'Test recruiter holds all nav scopes — ForbiddenState path not exercised (needs a reduced-scope user).',
      });
    }
  });

  test('logout returns to the sign-in flow (session cleared)', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Log out/ }).click();
    // Best-effort logout → redirect to the login path (which re-enters Cognito).
    await page.waitForURL(/\/auth\/recruiter\/login|amazoncognito\.com|\/login/i, {
      timeout: 20_000,
    });
  });
});
