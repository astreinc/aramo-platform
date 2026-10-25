// CCP-B2 — keyboard-only journeys on the Catalog (CCP handoff §9; PLATFORM-UX-1 §15): Tab /
// Shift+Tab / Enter / Space / Escape and typing into the focused field only — never a click.
// Every stop asserts a visible focus indicator; the request dialog traps focus and returns it to
// its opener on close.

import { expect, test } from '@playwright/test';

import type { MockOptions } from '../fixtures/mock-api';
import { openBuild } from '../support/build';
import { activate, expectFocusReturned, focusedHandle, tabTo, typeInto } from '../support/keyboard';

const CR_ID = 'cca10000-0000-7000-8000-00000000b201';

function withRequests(log: string[]): MockOptions {
  return {
    persona: 'catalogManager',
    catalog: { noOpenRequest: true },
    overrides: [
      {
        method: 'POST',
        path: /^\/platform\/commercial\/change-requests$/,
        reply: ({ body }) => {
          log.push(`create ${JSON.stringify(body)}`);
          return { status: 201, body: { request: { id: CR_ID, action_type: (body as { action_type: string }).action_type, state: 'DRAFT', required_chain: { rule: 'FINANCE_THEN_OWNER', steps: [] }, policy_version_id: 'pol-1' }, replayed: false } };
        },
      },
      {
        method: 'POST',
        path: /^\/platform\/commercial\/change-requests\/[^/]+\/submit$/,
        reply: ({ path }) => {
          log.push(`submit ${path}`);
          return { status: 200, body: { request: { id: CR_ID, action_type: 'PLAN_VERSION_PUBLISH', state: 'PENDING_APPROVAL', required_chain: { rule: 'FINANCE_THEN_OWNER', steps: [{ step_index: 0, role_key: 'finance_admin' }, { step_index: 1, role_key: 'platform_owner' }] }, policy_version_id: 'pol-1' } } };
        },
      },
    ],
  };
}

test.describe.configure({ mode: 'parallel' });

test('B2-K1 · choose Team, then v3 (draft), request publish by keyboard → change request created and submitted', async ({ page }) => {
  const log: string[] = [];
  await openBuild(page, '/commercial/catalog', withRequests(log));
  await activate(page, page.getByRole('button', { name: /^Sign Team/ }));
  await expect(page).toHaveURL(/plan=team/);
  await activate(page, page.getByRole('button', { name: /^v3/ }));
  await expect(page.getByText('Sign Team v3', { exact: true })).toBeVisible();
  const opener = page.getByRole('button', { name: 'Request publish…' });
  await activate(page, opener);
  const dialog = page.getByRole('dialog', { name: 'Request publish · Sign Team v3' });
  await expect(dialog).toBeVisible();
  await typeInto(page, dialog.getByLabel('Reason'), 'Annual price review');
  await typeInto(page, dialog.getByLabel('Evidence'), 'PR-2026-Q4');
  await activate(page, dialog.getByRole('button', { name: 'Submit for approval' }));
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/submitted · Finance → Owner/).first()).toBeVisible();
  expect(log[0]).toContain('"action_type":"PLAN_VERSION_PUBLISH"');
  expect(log[1]).toContain(`/change-requests/${CR_ID}/submit`);
});

test('B2-K2 · retire dialog: typed confirmation gates the commit; Escape closes and focus returns to "Request retire…"', async ({ page }) => {
  const log: string[] = [];
  await openBuild(page, '/commercial/catalog?plan=team&version=2', withRequests(log));
  const opener = page.getByRole('button', { name: 'Request retire…' });
  await tabTo(page, opener);
  const before = await focusedHandle(page);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Request retire · Sign Team v2' });
  await expect(dialog).toBeVisible();
  await typeInto(page, dialog.getByLabel('Reason'), 'Replaced by v3');
  await typeInto(page, dialog.getByLabel('Evidence'), 'PR-2026-Q4');
  const commit = dialog.getByRole('button', { name: 'Submit for approval' });
  await expect(commit).toBeDisabled();
  await typeInto(page, dialog.getByLabel(/to confirm/), 'Team v2');
  await expect(commit).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expectFocusReturned(page, before);
  expect(log).toEqual([]);
});

test('B2-K3 · published version: every field is disabled and skipped by Tab; the only stop is "Request retire…"', async ({ page }) => {
  await openBuild(page, '/commercial/catalog?plan=team&version=2', { persona: 'catalogManager' });
  const editor = page.getByTestId('version-editor');
  for (const input of await editor.getByRole('spinbutton').all()) await expect(input).toBeDisabled();
  await activate(page, page.getByRole('button', { name: /^v2/ }));
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /^v3/ })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(editor.getByRole('button', { name: 'Request retire…' })).toBeFocused();
});
