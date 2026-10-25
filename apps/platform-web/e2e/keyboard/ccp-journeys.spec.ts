// CCP-B1 — keyboard-only journeys for the Approvals inbox (CCP-UI v1.0 handoff §9;
// PLATFORM-UX-1 §15): Tab / Shift+Tab / Enter / Space / Escape / typing only, never
// a click. Every stop asserts a visible focus indicator (WCAG 2.4.7); the drawer and
// each dialog return focus on close (WCAG 2.4.3). The API is the stateful CCP
// fixture world (e2e/fixtures/commercial.ts): an approve or reject changes what the
// next read returns, and refusals are the engine's answers.

import { expect, test, type Page } from '@playwright/test';

import { CR, CcpWorld } from '../fixtures/commercial';
import { openBuild } from '../support/build';
import { activate, expectFocusReturned, expectFocusVisible, focusedHandle, tabTo, typeInto } from '../support/keyboard';

const drawer = (p: Page) => p.getByTestId('cr-drawer');
const dialog = (p: Page, name: RegExp) => p.getByRole('dialog', { name });
const toast = (p: Page, text: string | RegExp) => expect(p.getByText(text).first()).toBeVisible();

test.describe.configure({ mode: 'parallel' });

test('KC1 · finance: row → drawer → Approve → confirm → the step is signed through the route', async ({ page }) => {
  const w = new CcpWorld({ persona: 'ccpFinance' });
  await openBuild(page, '/commercial/approvals', w.mock());
  await activate(page, page.getByRole('row').filter({ has: page.getByText('$350 account credit') }));
  await expect(drawer(page)).toBeVisible();
  await expect(page.getByTestId('eligibility-verdict')).toHaveText(/You can sign the Finance step/);
  await activate(page, page.getByRole('button', { name: 'Approve' }));
  const confirm = dialog(page, /^Approve the Finance step/);
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('You sign the Finance step as Finance admin.');
  await activate(page, confirm.getByRole('button', { name: 'Approve' }));
  await expect(confirm).toBeHidden();
  await toast(page, /approved\.$/);
  expect(w.log).toContain(`approve ${CR.c1042} step=0`);
  // The request is Approved: no approve action any more.
  await expect(page.getByRole('dialog').getByText('Approved', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  // Focus stayed in the drawer (the footer changed under it).
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
  // Escape dismisses the topmost layer first (the toast, while it shows), then the
  // drawer; the inbox reloads without the signed request.
  for (let i = 0; i < 2 && (await drawer(page).isVisible()); i += 1) await page.keyboard.press('Escape');
  await expect(drawer(page)).toBeHidden();
  await expect(page.getByRole('tab', { name: /^Waiting on me/ })).toContainText('2');
});

test('KC2 · finance: Reject… → reason (required) → Reject request', async ({ page }) => {
  const w = new CcpWorld({ persona: 'ccpFinance' });
  await openBuild(page, `/commercial/approvals?request=${CR.c1052}`, w.mock());
  await expect(drawer(page)).toBeVisible();
  await activate(page, page.getByRole('button', { name: 'Reject…' }));
  const dlg = dialog(page, /^Reject /);
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Reject request' })).toBeDisabled();
  await typeInto(page, dlg.getByLabel(/Reason \(required\)/), 'A second extension inside the window needs a new contract.');
  await activate(page, dlg.getByRole('button', { name: 'Reject request' }));
  await expect(dlg).toBeHidden();
  await toast(page, /rejected\.$/);
  expect(w.log).toContain(`reject ${CR.c1052} reason=A second extension inside the window needs a new contract.`);
  await expect(page.getByRole('button', { name: 'Reject…' })).toHaveCount(0);
  // Focus returns into the drawer (the opener left the footer with the state change).
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
});

test('KC3 · ineligible (the combined Finance step already signed by me): no usable approve action, reason inline', async ({ page }) => {
  const w = new CcpWorld({ persona: 'ccpFinance' });
  await openBuild(page, '/commercial/approvals', w.mock());
  // The tab list by keyboard: All pending.
  await activate(page, page.getByRole('tab', { name: /^All pending/ }));
  await expect(page.getByRole('tab', { name: /^All pending/ })).toHaveAttribute('aria-selected', 'true');
  await activate(page, page.getByRole('row').filter({ has: page.getByText('Plan change') }));
  await expect(page.getByTestId('eligibility-verdict')).toHaveText(/You can’t approve: You already approved a step/);
  await expect(page.getByRole('button', { name: 'Approve' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reject…' })).toBeDisabled();
  await expect(page.getByTestId('cr-footnote')).toHaveText('You already approved a step.');
  // Disabled buttons are not tab stops: tabbing through the drawer never lands on Approve.
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
    expect(label).not.toBe('Approve');
  }
  expect(w.log.filter((l) => l.startsWith('approve'))).toEqual([]);
});

test('KC4 · the backend refuses an approve the verdict allowed: the refusal shows inline (409)', async ({ page }) => {
  const w = new CcpWorld({ persona: 'ccpFinance', refuseApprove: { [CR.c1044]: { code: 'COMMERCIAL_APPROVAL_REFUSED', details: { refusal: 'STEP_SCOPE_MISSING' } } } });
  await openBuild(page, `/commercial/approvals?request=${CR.c1044}`, w.mock());
  await activate(page, page.getByRole('button', { name: 'Approve' }));
  await activate(page, dialog(page, /^Approve the Finance step/).getByRole('button', { name: 'Approve' }));
  const alert = page.getByTestId('cr-refusal');
  await expect(alert).toBeVisible();
  await expect(alert).toHaveText(/Approval refused\. Missing the scope for this step\. The Finance step needs the Finance admin role\. \(409 COMMERCIAL_APPROVAL_REFUSED · STEP_SCOPE_MISSING\)/);
  expect(w.log).toContain(`approve ${CR.c1044} step=0`);
});

test('KC5 · Escape closes the drawer and focus returns to the row that opened it', async ({ page }) => {
  const w = new CcpWorld({ persona: 'ccpFinance' });
  await openBuild(page, '/commercial/approvals', w.mock());
  const row = page.getByRole('row').filter({ has: page.getByText('+14 day support extension (escalated)') });
  await tabTo(page, row);
  const opener = await focusedHandle(page);
  await page.keyboard.press('Enter');
  await expect(drawer(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toBeHidden();
  await expectFocusReturned(page, opener);
  await expectFocusVisible(page);
});
