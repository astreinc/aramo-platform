// CCP-PERSONAL-ARRANGED-1 §5.4 / §8 — the console moves a Free Personal tenant to a no-charge
// (COMP) Standard plan, end to end against the BUILD with the test-only fixture provider (no
// backend): Commercial ops raises "Move to an arranged plan…" (a SUBSCRIPTION_OPEN replacing the
// Free row), Finance then the Owner sign (CCP Amendment A3 AC-COMP-1: F → O for COMP), the
// requester applies, and the workbench shows the arranged row. One shared stateful world
// (fixtures/ccp-d4-world.ts) answers every person.

import { expect, test, type Page } from '@playwright/test';

import { ARRANGED_FREE_ROW, ARRANGED_TENANT, ARRANGED_TENANT_NAME, D4World, type D4Person } from '../fixtures/ccp-d4-world';
import { openBuild } from '../support/build';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

const tenantPath = `/tenants/${ARRANGED_TENANT}?tab=commercial`;
const signCard = (page: Page) => page.locator('section[data-product="sign"]');

async function as(page: Page, w: D4World, who: D4Person, path: string): Promise<void> {
  await openBuild(page, path, w.mock(who));
}

async function approveInDrawer(page: Page, w: D4World, who: D4Person, id: string, step: 'Finance' | 'Owner'): Promise<void> {
  await as(page, w, who, `/commercial/approvals?request=${id}`);
  await expect(page.getByTestId('eligibility-verdict')).toHaveText(new RegExp(`You can sign the ${step} step`));
  await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
  const confirm = page.getByRole('dialog', { name: new RegExp(`^Approve the ${step} step`) });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(confirm).toBeHidden();
}

test.describe('CCP-PERSONAL-ARRANGED-1 · move a Free Personal tenant to an arranged plan', () => {
  test('CPA-E2E-1 · Free → COMP Standard: request (Finance → Owner) → both sign → the requester applies → the workbench shows it', async ({ page }) => {
    const w = new D4World();

    // 1. Commercial ops: the Free row offers the one action; plan change and cancel are not offered.
    await as(page, w, 'tomas', tenantPath);
    await expect(signCard(page).getByRole('button', { name: 'Request plan change…' })).toHaveCount(0);
    await expect(signCard(page).getByRole('button', { name: 'Request cancel…' })).toHaveCount(0);
    await signCard(page).getByRole('button', { name: 'Move to an arranged plan…' }).click();
    const dlg = page.getByRole('dialog', { name: `Move to an arranged plan · ${ARRANGED_TENANT_NAME}` });
    await expect(dlg).toBeVisible();
    const plan = dlg.getByLabel('Personal plan');
    await expect(plan.locator('option')).toHaveText(['Sign Standard v1 · $10 / month']);
    await dlg.getByLabel('No charge (comp)').check();
    await expect(dlg.getByTestId('chain-preview')).toContainText('Finance → Owner');
    await dlg.getByLabel('Reason').fill('Internal user; Personal Standard arranged by Aramo.');
    await dlg.getByLabel('Internal reference (optional)').fill('HR-2026-0042');
    await dlg.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByText('Submitted for approval. Nothing applies until every step is signed and you apply it.')).toBeVisible();

    const r = w.requests.find((x) => x.action_type === 'SUBSCRIPTION_OPEN');
    expect(r?.state).toBe('PENDING_APPROVAL');
    expect(r?.payload).toEqual({ plan_key: 'aramo-sign-standard-personal-v1', plan_version_id: 'standard-personal-v1', replaces_subscription_id: ARRANGED_FREE_ROW, arrangement: 'COMP', external_ref: 'HR-2026-0042' });
    expect(r?.required_chain.rule).toBe('FINANCE_THEN_OWNER');

    // 2. Finance, then the Owner (AC-COMP-1). Not applicable after Finance alone.
    await approveInDrawer(page, w, 'priya', r!.id, 'Finance');
    expect(w.find(r!.id)?.state).toBe('PENDING_APPROVAL');
    await approveInDrawer(page, w, 'daniel', r!.id, 'Owner');
    expect(w.find(r!.id)?.state).toBe('APPROVED');

    // 3. The requester applies.
    await as(page, w, 'tomas', tenantPath);
    const apply = signCard(page).getByRole('button', { name: 'Apply', exact: true });
    await expect(apply).toBeVisible();
    await apply.click();
    await expect(page.getByText('Change applied.').first()).toBeVisible();
    expect(w.log).toContain(`tomas apply ${r!.id}`);
    await expect(signCard(page).getByText('Arranged by Aramo · no charge (comp)')).toBeVisible();

    // 4. The subscriptions workbench shows the arranged row.
    await as(page, w, 'tomas', '/commercial/subscriptions');
    const row = page.getByRole('row').filter({ hasText: ARRANGED_TENANT_NAME });
    await expect(row).toContainText('Sign Standard · Arranged (comp)');
    await expect(row).toContainText('MANUAL · arranged');
  });
});
