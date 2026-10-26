// CCP-B6 — keyboard-only journeys on the support-extension screen (directive §7; WCAG 2.1.1,
// 2.4.3, 2.4.7). Tab / Shift+Tab / Enter / Escape and typing only, never a click. Every stop
// asserts a visible focus indicator; the dialogs return focus to their opener on close.

import { expect, test } from '@playwright/test';

import type { Handler } from '../fixtures/mock-api';
import { SX_TENANTS, sxMock, sxPath } from '../fixtures/ccp-support';
import { openBuild } from '../support/build';
import { activate, expectFocusReturned, focusedHandle, tabTo, typeInto } from '../support/keyboard';

test.describe.configure({ mode: 'parallel' });

test('JB6-1 · support_admin: open the extension dialog, type a breach, read the escalation preview, Escape returns focus', async ({ page }) => {
  await openBuild(page, sxPath('fernhill'), sxMock('ccpSupport'));
  const opener = page.getByRole('button', { name: 'Request support extension…' });
  await tabTo(page, opener);
  const handle = await focusedHandle(page);
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog', { name: 'Request support extension · Fernhill Studio' });
  await expect(dlg).toBeVisible();
  const days = dlg.getByLabel('Extension (days)');
  await tabTo(page, days);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('20');
  await expect(dlg.getByRole('status')).toContainText('Out of bounds — escalates to approval (Finance)');
  await expect(dlg.getByTestId('chain-preview')).toContainText('Below threshold');
  await typeInto(page, dlg.getByLabel('Reason'), 'The practice moved offices');
  await tabTo(page, dlg.getByRole('button', { name: 'Submit for approval' }));
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expectFocusReturned(page, handle);
});

test('JB6-2 · support_admin: an in-bound extension applies as an exception by keyboard (one POST)', async ({ page }) => {
  const posts: unknown[] = [];
  const mock = sxMock('ccpSupport');
  const onPost: Handler = ({ body }) => {
    posts.push(body);
    return { status: 201, body: { outcome: 'APPLIED', replayed: false, request: { id: 'cc7e0000-0000-7000-8000-00000000f001', state: 'APPLIED' }, extension: null, application: {}, decision: null } };
  };
  await openBuild(page, sxPath('fernhill'), { ...mock, overrides: [{ method: 'POST', path: /^\/platform\/commercial\/support-extensions$/, reply: onPost }, ...(mock.overrides ?? [])] });
  await activate(page, page.getByRole('button', { name: 'Request support extension…' }));
  const dlg = page.getByRole('dialog', { name: 'Request support extension · Fernhill Studio' });
  await expect(dlg.getByRole('status')).toContainText('Within bounds — applies now as an exception, with zero approvals');
  await typeInto(page, dlg.getByLabel('Reason'), 'Billing contact on leave');
  await activate(page, dlg.getByRole('button', { name: 'Apply extension (exception)' }));
  await expect(page.getByText('Extension applied as an exception — zero approvals, flagged in audit.').first()).toBeVisible();
  expect(posts).toEqual([expect.objectContaining({ tenant_id: SX_TENANTS.fernhill, requested_days: 7, reason: 'Billing contact on leave', product_key: 'sign' })]);
});

test('JB6-3 · the open escalation links to the Approvals drawer by keyboard', async ({ page }) => {
  await openBuild(page, sxPath('oakridge'), sxMock('ccpFinance'));
  const link = page.getByRole('link', { name: 'CC7E0000' });
  // Reachable and visibly focused; its target is B1's Approvals route (not in this slice's base,
  // so following it is verified at merge).
  await tabTo(page, link);
  await expect(link).toHaveAttribute('href', '/commercial/approvals?request=cc7e0000-0000-7000-8000-000000001052');
});
