// CCP-UI-V12 — keyboard-only journeys on the v1.2 screens and the amended drawer (directive §7;
// WCAG 2.1.1, 2.4.3, 2.4.7). Tab / Shift+Tab / Enter / Space / Escape and typing only, never a
// click; every stop asserts a visible focus indicator (support/keyboard.ts).

import { expect, test } from '@playwright/test';

import { V12_CR, ccpMock } from '../fixtures/commercial';
import { v12Mock } from '../fixtures/ccp-v12';
import type { Handler } from '../fixtures/mock-api';
import { openBuild } from '../support/build';
import { activate, expectFocusReturned, focusedHandle, tabTo } from '../support/keyboard';

test.describe.configure({ mode: 'parallel' });

test('JV12-1 · Alerts: the status filter is a keyboard group; a subject link is reachable', async ({ page }) => {
  await openBuild(page, '/commercial/alerts', v12Mock('ccpFinance'));
  const resolved = page.getByRole('button', { name: /^Resolved/ });
  await activate(page, resolved);
  await expect(resolved).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Resolved automatically').first()).toBeVisible();
  await activate(page, page.getByRole('button', { name: /^Open/ }));
  await tabTo(page, page.getByRole('link', { name: /^Usage › Consumption$|·/ }).first());
});

test('JV12-2 · Renewals: the horizon select and Include lapsed by keyboard', async ({ page }) => {
  await openBuild(page, '/commercial/finance/renewals', v12Mock('ccpFinance'));
  await expect(page.getByTestId('renewals-count')).toHaveText('6 in view · 2 lapsed');
  const lapsed = page.getByRole('checkbox', { name: 'Include lapsed' });
  await tabTo(page, lapsed);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('renewals-count')).toHaveText('4 in view · 0 lapsed');
  // The horizon select is reachable with a visible focus ring (Shift+Tab back from the checkbox).
  await tabTo(page, page.getByRole('combobox', { name: 'Horizon' }), { back: true });
});

test('JV12-3 · the requester applies an approved request from the drawer by keyboard (one POST …/apply)', async ({ page }) => {
  const posts: string[] = [];
  const mock = ccpMock({ persona: 'ccpOps', v12: true })();
  const onApply: Handler = ({ path }) => {
    posts.push(path);
    return { status: 200, body: { request: { id: V12_CR.c1054, state: 'APPLIED' }, application: null, catalog_application: null, replayed: false } };
  };
  await openBuild(page, `/commercial/approvals?request=${V12_CR.c1054}`, { ...mock, overrides: [{ method: 'POST', path: /\/apply$/, reply: onApply }, ...(mock.overrides ?? [])] });
  await expect(page.getByTestId('cr-drawer')).toContainText('Apply by 2026-10-24 22:00 UTC · 8 h left · requester applies');
  await activate(page, page.getByRole('button', { name: 'Apply', exact: true }));
  await expect.poll(() => posts).toEqual([`/platform/commercial/change-requests/${V12_CR.c1054}/apply`]);
});

test('JV12-4 · Withdraw… on a failed policy activation: the dialog opens by keyboard and Escape returns focus', async ({ page }) => {
  await openBuild(page, `/commercial/approvals?request=${V12_CR.c1053}`, ccpMock({ persona: 'ccpFinance', v12: true })());
  const opener = page.getByRole('button', { name: 'Withdraw…' });
  await tabTo(page, opener);
  const handle = await focusedHandle(page);
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog', { name: /^Withdraw .+ · Activate policy v3$/ });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('Apply failed');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expectFocusReturned(page, handle);
});

test('JV12-5 · Usage refused: the alert link is reachable and points to Alerts', async ({ page }) => {
  await openBuild(page, '/commercial/usage', v12Mock('ccpFinance', { usage: 'notReconciled' }));
  const link = page.getByRole('link', { name: 'See the open alert →' });
  await tabTo(page, link);
  await expect(link).toHaveAttribute('href', '/commercial/alerts');
});
