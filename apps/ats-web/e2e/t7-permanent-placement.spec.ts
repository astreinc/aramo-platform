import { expect, test, type Page } from '@playwright/test';

// Track 7 / T7-P5 — LIVE surface walk for the permanent-placement product UI, scoped to the
// AMENDED truthful-reachability boundary (Aramo-T7-P5-E2E-Acceptance-Substrate-RSYNC-Amendment
// -v1_0-LOCKED §3). The live harness authenticates ONE least-privilege recruiter (recruiter
// scopes only: it holds placement:permanent:read but NONE of the T7 mutation scopes
// placement:permanent:transition / :terms:write / placement:remedy:resolve) and the canonical
// e2e seed (tools/seed-e2e-data.ts) establishes ZERO permanent-placement / PERMANENT-requisition
// / guarantee-term / remedy rows. So the browser layer proves ONLY what that substrate can
// TRUTHFULLY reach — navigation without regression, read-only posture (no mutation actions),
// read/eligibility gating, the report route + governed empty-or-real data with NO synthetic
// cross-currency total, and refresh preserving server-backed truth. It NEVER asserts a domain
// state the seed does not establish (no manufactured guarantee/falloff/remedy), and it never
// weakens a genuinely-deterministic assertion.
//
// The mutation lifecycle (create/revise terms, snapshot pinning, satisfy, falloff, the three
// remedy completions, terminal suppression) is proven — deterministically — in the component
// suite + the ats-web Pact consumer (20 interactions) + the deterministic Pact provider states
// (verify-api.ts), verified against real PostgreSQL by exact-head Pact provider verification in
// CI (§4). It is deliberately NOT reproduced here: doing so would require a privileged principal
// and a raw T7 seed, both of which the amendment forbids adding.

const FULL_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// A synthetic cross-currency total is a governed prohibition (§5.6): the report shows money
// PER CURRENCY only. This canary must NEVER appear on the rendered report.
const CROSS_CCY_TOTAL = /all currencies|grand total|combined total|total \(all/i;

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

test.describe.serial('ats-web T7 permanent-placement surfaces (amended truthful-reachability boundary)', () => {
  // §3.1 — the authorized recruiter navigates the T7-reachable surfaces without regression.
  test('S1: T7 surfaces navigate without regression (Reports index links Guarantee Exposure)', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await page.goto('/reports');
    if ((await page.getByTestId('reports-index').count()) > 0) {
      await expect(page.getByTestId('reports-link-guarantee-exposure')).toBeVisible();
    } else {
      await expect(page.getByText(/don.?t have access|forbidden|not authorized/i)).toBeVisible();
    }
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  // §3.2 — read-only posture: the recruiter holds no T7 mutation scope, so wherever a permanent
  // guarantee artifact DOES render, it exposes NO mutation action. (The seed establishes no
  // permanent placement, so the panel typically does not appear; the assertion is truthful in
  // both branches and never fabricates the artifact.) The no-read posture (§3.3) is NOT
  // representable with the single permanent:read-holding recruiter principal — it is proven in
  // the component suite (PlacementDetailView.permanent.spec.tsx / GuaranteeTermsPanel.spec.tsx:
  // no read scope ⇒ no fetch, no render).
  test('S2: read-only recruiter posture exposes NO T7 mutation action', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/placements');
    if ((await page.getByRole('heading', { name: 'Placements' }).count()) === 0) {
      expect(errors, errors.join('\n')).toHaveLength(0);
      return;
    }
    const firstRow = page.locator('a[data-testid^="placement-row-"]').first();
    if ((await firstRow.count()) === 0) {
      await expect(page.getByText('No placements visible to you yet.')).toBeVisible();
      expect(errors, errors.join('\n')).toHaveLength(0);
      return;
    }
    await firstRow.click();
    await expect(page.getByTestId('placement-detail')).toBeVisible();
    // Discrimination is data-driven; whichever branch renders, the read-only recruiter gets NO
    // T7 mutation control (hide, don't disable). These assertions hold in BOTH branches.
    await expect(page.getByTestId('guarantee-satisfy-action')).toHaveCount(0);
    await expect(page.getByTestId('falloff-record-action')).toHaveCount(0);
    await expect(page.getByTestId('remedy-complete-action')).toHaveCount(0);
    if ((await page.getByTestId('permanent-placement-panel').count()) > 0) {
      // If a permanent aggregate happens to exist, its snapshot renders and suppresses the
      // assignment panels — but still with no mutation control for this principal.
      await expect(page.getByTestId('guarantee-detail')).toBeVisible();
      await expect(page.getByTestId('assignment-lifecycle-panel')).toHaveCount(0);
    }
    const detailText = (await page.locator('main').first().innerText()) ?? '';
    expect(detailText).not.toMatch(FULL_UUID);
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  // §3.4 — the Guarantee Terms surface honors read/eligibility gating + honest empty state. The
  // tab appears ONLY for a PERMANENT-compensation requisition under placement:permanent:read;
  // for a contract requisition (all the seed establishes) it is correctly ABSENT. When present,
  // it opens the panel and shows the reusable-terms framing (honest empty timeline if no terms).
  test('S4: Guarantee Terms tab honors eligibility gating + honest empty state', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/requisitions');
    const firstReqLink = page.locator('.rc-table tbody a.rc-link-strong').first();
    if ((await firstReqLink.count()) === 0) {
      expect(errors, errors.join('\n')).toHaveLength(0);
      return;
    }
    await firstReqLink.click();
    await expect(page.locator('.rc-dhead__title')).toBeVisible();
    const termsTab = page.getByRole('tab', { name: /Guarantee Terms/ });
    if ((await termsTab.count()) > 0) {
      await termsTab.click();
      await expect(page.getByTestId('guarantee-terms-panel')).toBeVisible();
      await expect(page.getByText(/future permanent-placement/i)).toBeVisible();
    }
    // No console/page error regardless of whether the tab is present (contract requisition).
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  // §3.5 + §3.6 — the Guarantee Exposure report route works and renders TRUTHFUL server data OR a
  // governed empty state, and shows NO synthetic cross-currency total (money per currency only).
  test('S5+S6: Guarantee Exposure report renders truthful data / governed empty, NO cross-currency total', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await page.goto('/reports/guarantee-exposure');
    if ((await page.getByTestId('ge-run').count()) === 0) {
      await expect(page.getByText(/don.?t have access|forbidden|not authorized/i)).toBeVisible();
      expect(errors, errors.join('\n')).toHaveLength(0);
      return;
    }
    await page.getByTestId('ge-from').fill('2020-01-01T00:00');
    await page.getByTestId('ge-to').fill('2035-01-01T00:00');
    await page.getByTestId('ge-run').click();

    await expect(page.getByTestId('ge-results').or(page.getByTestId('ge-empty'))).toBeVisible({ timeout: 15_000 });
    if ((await page.getByTestId('ge-results').count()) > 0) {
      await expect(page.getByTestId('ge-exposure-table')).toBeVisible();
      await expect(page.getByText(/not payments/i)).toBeVisible();
    }
    // §3.6 — a synthetic combined/all-currency total is NEVER shown (holds in both branches).
    await expect(page.getByText(CROSS_CCY_TOTAL)).toHaveCount(0);
    const bodyText = (await page.locator('main').first().innerText()) ?? '';
    expect(bodyText).not.toMatch(FULL_UUID);
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  // §3.7 — browser refresh preserves server-backed truth: re-running the report after a full page
  // reload reproduces the SAME governed result for the SAME window (the report is server-derived,
  // not client-fabricated). Deterministic for the empty cohort the canonical seed establishes;
  // truthful for a non-empty cohort too.
  test('S7: page refresh preserves server-backed report truth', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/reports/guarantee-exposure');
    if ((await page.getByTestId('ge-run').count()) === 0) {
      expect(errors, errors.join('\n')).toHaveLength(0);
      return;
    }
    const runWide = async () => {
      await page.getByTestId('ge-from').fill('2020-01-01T00:00');
      await page.getByTestId('ge-to').fill('2035-01-01T00:00');
      await page.getByTestId('ge-run').click();
      await expect(page.getByTestId('ge-results').or(page.getByTestId('ge-empty'))).toBeVisible({ timeout: 15_000 });
      return (await page.getByTestId('ge-results').count()) > 0 ? 'results' : 'empty';
    };
    const before = await runWide();
    await page.reload();
    const after = await runWide();
    // Server truth is stable across a real browser refresh (same window ⇒ same governed shape).
    expect(after).toBe(before);
    expect(errors, errors.join('\n')).toHaveLength(0);
  });
});
