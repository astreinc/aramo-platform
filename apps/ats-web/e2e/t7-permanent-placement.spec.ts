import { expect, test, type Page } from '@playwright/test';

// Track 7 / T7-P5 — LIVE surface walk for the permanent-placement product UI (guarantee panel,
// lifecycle actions, guarantee-terms tab, guarantee-exposure report). Runs against the REAL stack
// with a genuine recruiter session (auth.setup.ts). Resilient to real-tenant data: a tenant may
// have zero permanent placements, so each surface asserts "content OR honest empty state", never
// a hard-coded fixture row. The dimensions harnesses cannot catch are checked here: scope-gated
// visibility (least-visibility — the read-only recruiter never sees a mutation action or a raw
// obligation editor), real empty/loading/error under latency, no UUID leak, and response-shape
// drift surfaced as console/page errors.

const FULL_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

test.describe.serial('ats-web T7 permanent-placement surfaces', () => {
  test('Reports landing links to the Guarantee Exposure report', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/reports');
    // The recruiter holds report:read → the Reports index renders and links to the report.
    // If report:read is absent, the route ForbiddenStates (the guard still bites) — both valid.
    if ((await page.getByTestId('reports-index').count()) > 0) {
      await expect(page.getByTestId('reports-link-guarantee-exposure')).toBeVisible();
    } else {
      await expect(page.getByText(/don.?t have access|forbidden|not authorized/i)).toBeVisible();
    }
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  test('Guarantee Exposure report: absolute window → per-currency summary OR honest empty state', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await page.goto('/reports/guarantee-exposure');

    // Scope gate: with report:read the report surface renders; otherwise ForbiddenState.
    if ((await page.getByTestId('ge-run').count()) === 0) {
      await expect(page.getByText(/don.?t have access|forbidden|not authorized/i)).toBeVisible();
      expect(errors, errors.join('\n')).toHaveLength(0);
      return;
    }

    // A wide, absolute [from, to) window (the surface sends absolute UTC instants).
    await page.getByTestId('ge-from').fill('2020-01-01T00:00');
    await page.getByTestId('ge-to').fill('2035-01-01T00:00');
    await page.getByTestId('ge-run').click();

    // Either a real cohort (per-currency table + the "not payments" obligation language) OR the
    // explicit zero-cohort empty state — never an indefinite spinner, never a crash.
    await expect(page.getByTestId('ge-results').or(page.getByTestId('ge-empty'))).toBeVisible({ timeout: 15_000 });
    if ((await page.getByTestId('ge-results').count()) > 0) {
      await expect(page.getByTestId('ge-exposure-table')).toBeVisible();
      await expect(page.getByText(/not payments/i)).toBeVisible();
    }
    const bodyText = (await page.locator('main').first().innerText()) ?? '';
    expect(bodyText).not.toMatch(FULL_UUID);
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  test('Placement detail: a permanent aggregate shows the guarantee panel with least-visibility (no mutation action for a read-only recruiter)', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await page.goto('/placements');
    if ((await page.getByRole('heading', { name: 'Placements' }).count()) === 0) {
      // No placement:read for this user — the guard bit; nothing more to assert here.
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

    // Discrimination is data-driven: a permanent placement shows the guarantee panel and suppresses
    // the assignment panels; a contract/legacy placement shows the assignment panel. Both are valid.
    const permanentPanel = page.getByTestId('permanent-placement-panel');
    if ((await permanentPanel.count()) > 0) {
      await expect(page.getByTestId('guarantee-detail')).toBeVisible();
      await expect(page.getByTestId('guarantee-status')).toBeVisible();
      // Least-visibility: this least-privilege recruiter holds no transition/resolve scope, so no
      // mutation action is offered (hide, don't disable).
      await expect(page.getByTestId('guarantee-satisfy-action')).toHaveCount(0);
      await expect(page.getByTestId('falloff-record-action')).toHaveCount(0);
      await expect(page.getByTestId('remedy-complete-action')).toHaveCount(0);
      // The assignment panels are suppressed (never shown alongside a permanent aggregate).
      await expect(page.getByTestId('assignment-lifecycle-panel')).toHaveCount(0);
      const detailText = (await page.locator('main').first().innerText()) ?? '';
      expect(detailText).not.toMatch(FULL_UUID);
    }
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  test('Requisition detail: the Guarantee Terms tab appears only for a permanent-compensation requisition', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await page.goto('/requisitions');
    const firstReqLink = page.locator('.rc-table tbody a.rc-link-strong').first();
    if ((await firstReqLink.count()) === 0) {
      // Empty tenant — nothing to drill into; no crash is the assertion.
      expect(errors, errors.join('\n')).toHaveLength(0);
      return;
    }

    await firstReqLink.click();
    await expect(page.locator('.rc-dhead__title')).toBeVisible();

    // The Guarantee Terms tab is present ONLY for a PERMANENT-compensation requisition when the
    // actor holds placement:permanent:read. If present, it opens the terms panel (read path); if
    // absent (contract requisition or no scope), that is the correct hidden state. Either way the
    // detail must not error.
    const termsTab = page.getByRole('tab', { name: /Guarantee Terms/ });
    if ((await termsTab.count()) > 0) {
      await termsTab.click();
      await expect(page.getByTestId('guarantee-terms-panel')).toBeVisible();
      // Reusable-terms framing: revisions apply to future activations only.
      await expect(page.getByText(/future permanent-placement/i)).toBeVisible();
    }
    expect(errors, errors.join('\n')).toHaveLength(0);
  });
});
