// CCP-B5 — keyboard-only journeys on the governance screens (PLATFORM-UX-1 §7; WCAG 2.1.1,
// 2.4.3, 2.4.7): Tab / Shift+Tab / Enter / Space / Escape and typing only — never a click.
// Every stop shows a visible focus indicator; every dialog returns focus to its opener. The
// fixture answers the writes, and the journey asserts what the console sent.

import { expect, test, type Page } from '@playwright/test';

import { ccpEditedDraft, ccpMock, type CcpMockOptions } from '../fixtures/ccp-governance';
import type { MockOptions } from '../fixtures/mock-api';
import { openBuild } from '../support/build';
import { activate, expectFocusReturned, focusedHandle, tabTo, typeInto } from '../support/keyboard';

const dialog = (p: Page) => p.getByRole('dialog');

function withWrites(o: CcpMockOptions, sent: Array<{ method: string; path: string; body: unknown }>): MockOptions {
  const base = ccpMock(o);
  const record = (status: number, body: unknown | ((reqBody: unknown) => unknown)) => (req: { method: string; path: string; body: unknown }) => {
    sent.push({ method: req.method, path: req.path, body: req.body });
    return { status, body: typeof body === 'function' ? (body as (b: unknown) => unknown)(req.body) : body };
  };
  return {
    overrides: [
      { method: 'PATCH', path: /^\/platform\/commercial\/policy-versions\/[^/]+$/, reply: record(200, (b) => ({ version: ccpEditedDraft(((b as { content?: Record<string, unknown> }).content) ?? {}) })) },
      { method: 'POST', path: /^\/platform\/commercial\/change-requests$/, reply: record(201, { request: { id: '019a0000-0000-7000-8000-00000000c0de', action_type: 'X', state: 'DRAFT' }, replayed: false }) },
      { method: 'POST', path: /^\/platform\/commercial\/change-requests\/[^/]+\/submit$/, reply: record(200, { request: { id: '019a0000-0000-7000-8000-00000000c0de', action_type: 'X', state: 'PENDING_APPROVAL' } }) },
      { method: 'POST', path: /^\/platform\/commercial\/audit-events\/export$/, reply: record(200, { export_id: 'x', exported_at: '2026-10-24T14:00:00.000Z', row_count: 16, filename: 'commercial-audit.csv', content_type: 'text/csv', csv: 'id\r\n', csv_sha256: 'c'.repeat(64) }) },
      ...(base.overrides ?? []),
    ],
  };
}

test('K-B5-1 · policy: select a version, edit a draft value, request activation (finance_admin)', async ({ page }) => {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  await openBuild(page, '/commercial/policy', withWrites({ persona: 'priya' }, sent));
  await activate(page, page.getByRole('button', { name: /^v1/ }));
  await expect(page.getByText('This is the active version')).toBeVisible();
  await activate(page, page.getByRole('button', { name: /^v2/ }), 'Space');
  await expect(page.getByRole('heading', { name: 'Policy v2' })).toBeVisible();
  await tabTo(page, page.getByLabel('Past-due grace'));
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('10');
  await page.keyboard.press('Tab');
  await expect.poll(() => sent.filter((s) => s.method === 'PATCH').length).toBe(1);
  expect(sent[0]?.body).toEqual({ content: { past_due_grace_days: 10 } });
  await tabTo(page, page.getByRole('button', { name: 'Request activation…' }));
  const opener = await focusedHandle(page);
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  await typeInto(page, dialog(page).getByLabel('Reason'), 'Q3 review');
  await typeInto(page, dialog(page).getByLabel('Evidence'), 'FIN-2026-Q3');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expectFocusReturned(page, opener);
  await page.keyboard.press('Enter');
  await typeInto(page, dialog(page).getByLabel('Reason'), 'Q3 review');
  await typeInto(page, dialog(page).getByLabel('Evidence'), 'FIN-2026-Q3');
  await activate(page, dialog(page).getByRole('button', { name: 'Submit for approval' }));
  await expect(dialog(page)).toBeHidden();
  const create = sent.find((s) => s.method === 'POST' && s.path === '/platform/commercial/change-requests');
  expect(create?.body).toMatchObject({ action_type: 'POLICY_ACTIVATE', payload: { policy_version_id: '019a0000-0000-7000-8000-0000000cc2a2' } });
});

test('K-B5-2 · audit: filters by keyboard, then export (read-only, audited)', async ({ page }) => {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  await openBuild(page, '/commercial/audit', withWrites({ persona: 'ines' }, sent));
  await tabTo(page, page.getByLabel('Actor'));
  await tabTo(page, page.getByLabel('Change request'));
  await activate(page, page.getByLabel('Exceptions only'), 'Space');
  await expect(page.getByLabel('Exceptions only')).toBeChecked();
  await activate(page, page.getByLabel('Exceptions only'), 'Space');
  await activate(page, page.getByRole('button', { name: /^Export CSV/ }));
  await expect.poll(() => sent.filter((s) => s.path === '/platform/commercial/audit-events/export').length).toBe(1);
  await expect(page.getByText('Exported 16 events. The export is itself recorded.').first()).toBeVisible();
});

test('K-B5-3 · platform admins: open a role change, toggle a role, cancel with Escape (focus returns); submit sends a governed ROLE_GRANT', async ({ page }) => {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  await openBuild(page, '/admins', withWrites({ persona: 'daniel' }, sent));
  const btn = page.getByRole('row', { name: /Ines Duarte/ }).getByRole('button', { name: 'Request role change…' });
  await tabTo(page, btn);
  const opener = await focusedHandle(page);
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  await activate(page, dialog(page).getByRole('button', { name: '+ Support admin' }), 'Space');
  await expect(dialog(page).getByRole('button', { name: '✓ Support admin' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expectFocusReturned(page, opener);
  await page.keyboard.press('Enter');
  await activate(page, dialog(page).getByRole('button', { name: '+ Support admin' }), 'Space');
  await typeInto(page, dialog(page).getByLabel('Reason'), 'Cover for support');
  await typeInto(page, dialog(page).getByLabel('Evidence'), 'HR-1');
  await activate(page, dialog(page).getByRole('button', { name: 'Submit for approval' }));
  await expect(dialog(page)).toBeHidden();
  const creates = sent.filter((s) => s.method === 'POST' && s.path === '/platform/commercial/change-requests');
  expect(creates.map((c) => c.body)).toEqual([expect.objectContaining({ action_type: 'ROLE_GRANT', payload: { subject_user_id: expect.any(String), role_key: 'support_admin' } })]);
});
