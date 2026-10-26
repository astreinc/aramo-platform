// CCP-B3 — keyboard-only journeys on the Subscriptions workbench and Tenant › Commercial
// (directive §7; WCAG 2.1.1, 2.4.3, 2.4.7). Tab / Enter / Space / Escape and typing only, never
// a click. The dialogs return focus to their opener on close; every write is a change request.

import { expect, test } from '@playwright/test';

import type { Handler } from '../fixtures/mock-api';
import { B3_TENANTS, subsMock, tenantPath } from '../fixtures/ccp-subscriptions';
import { openBuild } from '../support/build';
import { activate, expectFocusReturned, focusedHandle, tabTo, typeInto } from '../support/keyboard';

test.describe.configure({ mode: 'parallel' });

test('JB3-1 · workbench: a status segment and the flag filter by keyboard; a row opens Tenant › Commercial with Enter', async ({ page }) => {
  await openBuild(page, '/commercial/subscriptions', subsMock('ccpOwner'));
  await activate(page, page.getByRole('button', { name: /^In grace/ }), 'Space');
  await expect(page.getByTestId('subscriptions-count')).toHaveText('1 of 8');
  await activate(page, page.getByRole('button', { name: /^All/ }));
  await tabTo(page, page.getByRole('checkbox', { name: 'Has reconciliation flag' }));
  await page.keyboard.press('Space');
  await expect(page.getByTestId('subscriptions-count')).toHaveText('1 of 8');
  const row = page.getByRole('row', { name: /Meridian Partners/ });
  await tabTo(page, row);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/tenants/${B3_TENANTS.meridian}\\?tab=commercial$`));
  await expect(page.getByRole('tab', { name: 'Commercial' })).toHaveAttribute('aria-selected', 'true');
});

test('JB3-2 · commercial_ops: revoke by keyboard (typed confirm) creates and submits one ENTITLEMENT_REVOKE; Escape on a second open returns focus', async ({ page }) => {
  const posts: { path: string; body: unknown }[] = [];
  const mock = subsMock('ccpOps');
  const created: Handler = ({ path, body }) => {
    posts.push({ path, body });
    return { status: 201, body: { request: { id: 'cb300000-0000-7000-8000-00000000e001', action_type: 'ENTITLEMENT_REVOKE', kind: 'NORMAL', state: 'DRAFT', tenant_id: B3_TENANTS.atlas, product_key: 'sign', payload: {}, requested_by: 'x', reason: 'r', created_at: '2026-10-24T14:00:00Z' }, replayed: false } };
  };
  const submitted: Handler = ({ path }) => {
    posts.push({ path, body: null });
    return { status: 200, body: { request: { id: 'cb300000-0000-7000-8000-00000000e001', state: 'PENDING_APPROVAL' } } };
  };
  await openBuild(page, tenantPath('atlas'), {
    ...mock,
    overrides: [
      { method: 'POST', path: /^\/platform\/commercial\/change-requests$/, reply: created },
      { method: 'POST', path: /^\/platform\/commercial\/change-requests\/[^/]+\/submit$/, reply: submitted },
      ...(mock.overrides ?? []),
    ],
  });
  const opener = page.locator('section[data-product="sign"]').getByRole('button', { name: 'Revoke product…' });
  await tabTo(page, opener);
  const handle = await focusedHandle(page);
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog', { name: 'Revoke product · Aramo Sign' });
  await expect(dlg).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expectFocusReturned(page, handle);
  await page.keyboard.press('Enter');
  await expect(dlg).toBeVisible();
  await typeInto(page, dlg.getByLabel('Reason'), 'Tenant asked to stop using Sign');
  await typeInto(page, dlg.getByLabel('Evidence'), 'Ticket SUP-2041');
  await typeInto(page, dlg.getByLabel(/to confirm/), 'Atlas Freight');
  await activate(page, dlg.getByRole('button', { name: 'Submit for approval' }));
  await expect(dlg).toBeHidden();
  expect(posts.map((p) => p.path)).toEqual(['/platform/commercial/change-requests', '/platform/commercial/change-requests/cb300000-0000-7000-8000-00000000e001/submit']);
  expect(posts[0]!.body).toEqual(expect.objectContaining({ action_type: 'ENTITLEMENT_REVOKE', tenant_id: B3_TENANTS.atlas, payload: { capabilities: ['sign'] } }));
});

test('JB3-3 · the held activation: the release action is reachable and opens its dialog by keyboard', async ({ page }) => {
  await openBuild(page, tenantPath('meridian'), subsMock('ccpOps', { noRelease: true }));
  const held = page.getByTestId('held-activation');
  await expect(held).toHaveAttribute('role', 'alert');
  await activate(page, held.getByRole('button', { name: 'Request reconciliation release…' }));
  const dlg = page.getByRole('dialog', { name: 'Request reconciliation release · Meridian Partners' });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId('chain-preview')).toContainText('Below threshold');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
});

test('JB3-4 · the release in Stripe links to the Approvals drawer by keyboard', async ({ page }) => {
  await openBuild(page, tenantPath('meridian'), subsMock('ccpFinance'));
  const link = page.getByTestId('held-activation').getByRole('link');
  await tabTo(page, link);
  await expect(link).toHaveAttribute('href', '/commercial/approvals?request=cb300000-0000-7000-8000-000000001051');
});
