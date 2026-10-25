// CCP-B4 — keyboard-only journeys on Commercial › Contracts (PLATFORM-UX-1 §15,
// handoff §9): Tab / Shift+Tab / Enter / Escape and typing only — never a click.
// Every stop shows a visible focus indicator; the dialog traps focus and returns
// it to its opener; the commit only CREATES and SUBMITS a change request.

import { expect, test } from '@playwright/test';

import { contractsMock } from '../fixtures/contracts';
import { openBuild } from '../support/build';
import { activate, expectFocusReturned, expectFocusVisible, focusedHandle, tabTo, typeInto } from '../support/keyboard';
import type { MockTracker } from '../fixtures/mock-api';

const log = (p: unknown): string[] => ((p as { __mock?: MockTracker }).__mock?.log ?? []).filter((l) => !l.startsWith('GET'));

test('K-B4-1 · select a contract, record an amendment, submit for approval (change request only)', async ({ page }) => {
  await openBuild(page, '/commercial/contracts', contractsMock('tomas'));
  await activate(page, page.getByRole('button', { name: /CT-2024-019/ }));
  await expect(page.getByRole('heading', { name: 'Brightline Retail · Sign Business' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record amendment…' })).toHaveCount(0);
  await activate(page, page.getByRole('button', { name: /CT-2024-007/ }), 'Space');
  await expect(page.getByRole('heading', { name: 'Halcyon Health · Sign Enterprise' })).toBeVisible();
  const opener = page.getByRole('button', { name: 'Record amendment…' });
  await tabTo(page, opener);
  const handle = await focusedHandle(page);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Record amendment · CT-2024-007' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Amendment')).toBeFocused();
  await expectFocusVisible(page);
  await page.keyboard.type('Allowance raised to 30,000 envelopes per month');
  await typeInto(page, dialog.getByLabel('Reason'), 'Seasonal volume');
  await typeInto(page, dialog.getByLabel('Evidence'), 'Email from Halcyon, 19 Oct');
  await activate(page, dialog.getByRole('button', { name: 'Submit for approval' }));
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/submitted for approval/).first()).toBeVisible();
  await expectFocusReturned(page, handle);
  expect(log(page)).toEqual(['POST /platform/commercial/change-requests', 'POST /platform/commercial/change-requests/019a0000-0000-7000-8000-00000000cb41/submit']);
});

test('K-B4-2 · End contract… traps focus, needs the typed id, and Escape closes it back to the opener', async ({ page }) => {
  await openBuild(page, '/commercial/contracts', contractsMock('tomas'));
  const opener = page.getByRole('button', { name: 'End contract…' });
  await tabTo(page, opener);
  const handle = await focusedHandle(page);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'End contract · CT-2024-007' });
  await expect(dialog.getByLabel('Reason')).toBeFocused();
  // Shift+Tab from the first field wraps to the last focusable control (Cancel; commit is disabled).
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('Reason')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expectFocusReturned(page, handle);
  expect(log(page)).toEqual([]);
});

test('K-B4-3 · a role without the request scope reaches disabled actions with their reason; catalog_manager gets the in-shell access denied', async ({ page }) => {
  await openBuild(page, '/commercial/contracts', contractsMock('ines'));
  const amend = page.getByRole('button', { name: 'Record amendment…' });
  await tabTo(page, amend);
  await expect(amend).toHaveAttribute('aria-disabled', 'true');
  await expect(amend).toHaveAttribute('title', 'Needs the Commercial ops role.');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await openBuild(page, '/commercial/contracts', contractsMock('lena'));
  await expect(page.getByText(/Contracts/).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Contracts', exact: true })).toHaveCount(0);
});
