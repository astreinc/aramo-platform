// PLATFORM-UX-1 H-1 — keyboard-only journeys 1–7, 9 and 10 (implementation
// prompt §5; directive §7). Tab / Shift+Tab / Enter / Space / Escape / arrows and
// typing into the focused field only — never a click. Every stop asserts a
// visible focus indicator (WCAG 2.4.7); every dialog and the drawer returns
// focus to its opener on close (WCAG 2.4.3). The API is the stateful fixture
// World, so a mutation shows up in the next read.

import { expect, test, type Page } from '@playwright/test';

import { World } from '../fixtures/world';
import { openBuild } from '../support/build';
import { activate, expectFocusReturned, expectFocusVisible, focusedHandle, tabTo, typeInto } from '../support/keyboard';

const dialog = (p: Page) => p.getByRole('dialog');
const toast = (p: Page, text: string | RegExp) => expect(p.getByText(text).first()).toBeVisible();

test.describe.configure({ mode: 'parallel' });

test('J1 · dashboard → Provisioned tile → tenant → resend owner invite', async ({ page }) => {
  const w = new World();
  await openBuild(page, '/', w.mock());
  await activate(page, page.getByRole('button', { name: /^Provisioned/ }));
  await expect(page).toHaveURL(/\/tenants\?status=PROVISIONED/);
  await activate(page, page.getByRole('row', { name: 'Open Halvorsen Clinics' }));
  await expect(page).toHaveURL(/\/tenants\/tn_01JA7HVC2K/);
  await activate(page, page.getByRole('button', { name: 'Resend owner invite' }));
  await toast(page, 'Owner invite sent to Halvorsen Clinics.');
  expect(w.log).toContain('resend tn_01JA7HVC2K');
});

test('J2 · provision a Business tenant with Sign → review → detail', async ({ page }) => {
  const w = new World();
  await openBuild(page, '/tenants', w.mock());
  await activate(page, page.getByRole('button', { name: '+ Provision tenant' }));
  await expect(page).toHaveURL(/\/tenants\/new/);
  await typeInto(page, page.getByLabel('Tenant name'), 'Juniper Health');
  await typeInto(page, page.getByLabel('Owner email'), 'anna.berg@juniperhealth.com');
  await activate(page, page.getByRole('button', { name: 'Continue' }));
  await activate(page, page.getByRole('checkbox', { name: /^Sign/ }), 'Space');
  await expect(page.getByRole('checkbox', { name: /^Sign/ })).toBeChecked();
  await activate(page, page.getByRole('button', { name: 'Review' }));
  await activate(page, page.getByRole('button', { name: 'Provision tenant' }));
  await expect(page).toHaveURL(/\/tenants\/tn_01JB7JUNIPR/);
  await toast(page, /Juniper Health provisioned/);
  expect(w.log.find((l) => l.startsWith('provision'))).toMatch(/caps=.*sign/);
});

async function lifecycle(page: Page, action: RegExp): Promise<Awaited<ReturnType<typeof focusedHandle>>> {
  await activate(page, page.getByRole('button', { name: 'Lifecycle actions' }));
  const menu = page.getByRole('menu', { name: 'Lifecycle actions' });
  await expect(menu).toBeVisible();
  // The menu's own keyboard model: arrows move, Enter selects.
  for (let i = 0; i < 6; i += 1) {
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
    if (action.test(focused)) break;
    await page.keyboard.press('ArrowDown');
  }
  await expectFocusVisible(page);
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  return page.evaluateHandle(() => document.querySelector('.pw-lcmenu__trigger'));
}

test('J3 · suspend an Active tenant → timeline shows it → reactivate', async ({ page }) => {
  const w = new World();
  await openBuild(page, '/tenants/tn_01J8Q2NWX4?tab=lifecycle', w.mock());
  const opener = await lifecycle(page, /^Suspend/);
  await tabTo(page, dialog(page).getByLabel('Reason', { exact: true }));
  await page.keyboard.type('Payment');
  await typeInto(page, dialog(page).getByLabel('Reason details'), 'Invoice unpaid after 30 days.');
  await activate(page, dialog(page).getByRole('button', { name: 'Suspend tenant' }));
  await expect(dialog(page)).toBeHidden();
  await toast(page, /Northwind Logistics is now suspended/i);
  await expectFocusReturned(page, opener);
  await expect(page.locator('.pw-timeline__label').first()).toHaveText('Suspended');
  await lifecycle(page, /^Reactivate/);
  await tabTo(page, dialog(page).getByLabel('Reason', { exact: true }));
  await page.keyboard.type('Payment');
  await activate(page, dialog(page).getByRole('button', { name: 'Reactivate tenant' }));
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator('.pw-timeline__label').first()).toHaveText('Reactivated');
  expect(w.log).toEqual(['suspend tn_01J8Q2NWX4', 'reactivate tn_01J8Q2NWX4']);
});

test('J4 · offboard → close, with the terminal acknowledgement', async ({ page }) => {
  const w = new World();
  await openBuild(page, '/tenants/tn_01J7TDW9HA', w.mock());
  await lifecycle(page, /^Start offboarding/);
  await tabTo(page, dialog(page).getByLabel('Retention policy'));
  await page.keyboard.type('Standard');
  // The date field's segments follow the browser UI locale (en-US: mm/dd/yyyy).
  await tabTo(page, dialog(page).getByLabel('Close at'));
  await page.keyboard.type('11302026');
  await activate(page, dialog(page).getByRole('button', { name: 'Start offboarding' }));
  await expect(dialog(page)).toBeHidden();
  await lifecycle(page, /^Close tenant/);
  await tabTo(page, dialog(page).getByLabel('Reason', { exact: true }));
  await page.keyboard.type('Offboarding');
  const commit = dialog(page).getByRole('button', { name: 'Close tenant permanently' });
  await expect(commit).toBeDisabled();
  await activate(page, dialog(page).getByRole('checkbox', { name: /closing is terminal/ }), 'Space');
  await activate(page, commit);
  await expect(dialog(page)).toBeHidden();
  expect(w.log).toEqual(['start-offboarding tn_01J7TDW9HA', 'close tn_01J7TDW9HA']);
});

test('J5 · domain: promote with evidence; grant and revoke an exception', async ({ page }) => {
  const w = new World();
  await openBuild(page, '/tenants/tn_01JA7HVC2K?tab=domain', w.mock());
  await tabTo(page, page.getByRole('button', { name: 'Promote to authoritative…' }));
  const opener = await focusedHandle(page);
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  // Escape cancels and returns focus to the opener.
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expectFocusReturned(page, opener);
  await page.keyboard.press('Enter');
  await typeInto(page, dialog(page).getByLabel('Evidence reference'), 'DNS-TXT-4471');
  await activate(page, dialog(page).getByRole('button', { name: 'Promote claim' }));
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByText('Authoritative').first()).toBeVisible();
  await activate(page, page.getByRole('button', { name: 'Grant shared-domain exception…' }));
  await typeInto(page, dialog(page).getByLabel('Justification'), 'Shared with a sister clinic under contract.');
  await typeInto(page, dialog(page).getByLabel('Evidence reference'), 'CASE-3001');
  await activate(page, dialog(page).getByRole('button', { name: 'Grant exception' }));
  await expect(dialog(page)).toBeHidden();
  await activate(page, page.getByRole('button', { name: /^Revoke/ }));
  await activate(page, dialog(page).getByRole('button', { name: 'Revoke exception' }));
  await expect(dialog(page)).toBeHidden();
  expect(w.log).toEqual(['promote tn_01JA7HVC2K', 'grant tn_01JA7HVC2K', 'revoke tn_01JA7HVC2K']);
});

test('J6 · personal review: open an account → restrict until a date → reinstate', async ({ page }) => {
  const w = new World();
  await openBuild(page, '/personal-review', w.mock());
  await activate(page, page.getByRole('button', { name: 'Amara Nwosu', exact: true }));
  const rowOpener = await page.evaluateHandle(() => document.querySelector('[data-testid="personal-review-pa_01HV7"] .pw-sp-row__name'));
  const drawer = page.getByTestId('personal-drawer');
  await expect(drawer).toBeVisible();
  await activate(page, page.getByRole('button', { name: 'Restrict…' }));
  await typeInto(page, dialog(page).last().getByLabel('Reason'), 'Phone step not completed after two reminders.');
  await tabTo(page, dialog(page).last().getByLabel('Restrict until (optional)'));
  await page.keyboard.type('11072026');
  await page.keyboard.press('Tab');
  await page.keyboard.type('0300P');
  await activate(page, dialog(page).last().getByRole('button', { name: 'Restrict account' }));
  await toast(page, 'Restrict account: Amara Nwosu.');
  await activate(page, page.getByRole('button', { name: 'Reinstate…' }));
  await typeInto(page, dialog(page).last().getByLabel('Reason'), 'Phone verified by support.');
  await activate(page, dialog(page).last().getByRole('button', { name: 'Reinstate account' }));
  await toast(page, 'Reinstate account: Amara Nwosu.');
  // Escape closes the drawer and focus returns to the row's opener. The shared
  // Radix toast is itself an Escape-dismissable layer, so it is let go first
  // (finding reported in H-1: the first Escape dismisses a visible toast, the next
  // closes the drawer).
  for (let i = 0; i < 3 && (await drawer.isVisible()); i += 1) await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expectFocusReturned(page, rowOpener);
  expect(w.log[0]).toMatch(/^restrict pa_01HV7 until=2026-11-07T15:00/);
  expect(w.log[1]).toMatch(/^reinstate pa_01HV7/);
});

test('J7 · skills: queue surface → add as alias; accept a proposal, and the 409', async ({ page }) => {
  const w = new World();
  w.staleProposal = 'pp_01HA';
  await openBuild(page, '/skills/review-queue', w.mock());
  await activate(page, page.getByRole('button', { name: 'Add as alias…' }).first());
  await tabTo(page, dialog(page).getByLabel('Skill'));
  await page.keyboard.type('Kub');
  await activate(page, dialog(page).getByRole('button', { name: 'Add alias' }));
  await expect(dialog(page)).toBeHidden();
  expect(w.log[0]).toMatch(/^alias k8s admin -> sk_01J1KUBE/);
  // Accept a proposal, then a stale one (409).
  await page.goto('/skills/proposals/pp_01H8');
  await activate(page, page.getByRole('button', { name: 'Accept and apply' }));
  await toast(page, /accepted/i);
  await page.goto('/skills/proposals/pp_01HA');
  await activate(page, page.getByRole('button', { name: 'Accept and apply' }));
  await expect(page.getByText(/no longer pending/i).first()).toBeVisible();
  expect(w.log).toContain('accept pp_01H8');
  expect(w.log).toContain('accept-409 pp_01HA');
});

test('J9 · matching: edit as a new version → activate with the diff', async ({ page }) => {
  const w = new World();
  await openBuild(page, '/matching', w.mock());
  await activate(page, page.getByRole('button', { name: 'Edit as new version' }));
  const first = page.getByRole('spinbutton').first();
  await tabTo(page, first);
  await page.keyboard.press('ArrowUp');
  await activate(page, page.getByRole('button', { name: /^Save draft/ }));
  await toast(page, /Draft v4 saved/);
  await activate(page, page.getByRole('button', { name: 'Activate v4…' }));
  await expect(dialog(page).getByRole('table')).toBeVisible();
  await activate(page, dialog(page).getByRole('button', { name: 'Activate v4' }));
  await expect(dialog(page)).toBeHidden();
  expect(w.log).toEqual(['matching draft v4', 'matching activate mpv_4']);
});

test('J10 · wrong account: tenant user → in-shell access denied → different account', async ({ page }) => {
  await openBuild(page, '/', { persona: 'tenantUser' });
  await expect(page.getByTestId('access-denied')).toBeVisible();
  const login = page.waitForRequest((r) => /\/auth\/platform\/login/.test(r.url()) && /select_account=1/.test(r.url()));
  await activate(page, page.getByRole('button', { name: 'Sign in with a different account' }));
  await login;
});
