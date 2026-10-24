// PLATFORM-UX-1 H-1 — the Template Studio journeys (implementation prompt §5 J8 and the
// Studio journey J11; directive §7), keyboard only: Tab / Shift+Tab / Enter / Space /
// Escape / arrows, typing, and the Studio's own shortcuts (⌘S, ⌘⇧P, ⌥↑/↓, {{). The
// API is the stateful TemplateWorld, so a save, preview, publish or withdrawal shows
// up in the next read. Drag and drop is pointer-only in the design: it has its own
// pointer test below.

import { expect, test, type Page } from '@playwright/test';

import { TemplateWorld } from '../fixtures/templates';
import { openBuild } from '../support/build';
import { activate, expectFocusReturned, expectFocusVisible, focusedHandle, tabTo, typeInto } from '../support/keyboard';

const dialog = (p: Page) => p.getByRole('dialog');
const toast = (p: Page, text: string | RegExp) => expect(p.getByText(text).first()).toBeVisible();
const blocks = (p: Page) => p.locator('[data-block-id]');

test.describe.configure({ mode: 'parallel' });

test('J8 · create a template → draft with variables → preview → publish → withdraw with 7 days notice', async ({ page }) => {
  const w = new TemplateWorld();
  await openBuild(page, '/document-templates', w.mock());

  // Create (blank document of a configurable type).
  await activate(page, page.getByRole('button', { name: '+ Create default template' }));
  await expect(dialog(page)).toBeVisible();
  await tabTo(page, dialog(page).getByLabel('Document type'));
  await page.keyboard.type('Rejection');
  await expect(dialog(page).getByLabel('Document type')).toHaveValue('dty_rejection');
  await typeInto(page, dialog(page).getByLabel('Name'), 'Rejection letter');
  await activate(page, dialog(page).getByRole('button', { name: 'Create and open studio' }));
  await expect(page).toHaveURL(/\/document-templates\/dt_01JBNEW1$/);
  await expect(page.getByText('Start this template')).toBeVisible();

  // Draft: a title, then a paragraph with a {{variable}} picked from the popover.
  await typeInto(page, page.locator('.pws-page__title-in'), 'Your application');
  await activate(page, page.getByRole('button', { name: 'Add a paragraph' }));
  await expect(blocks(page)).toHaveCount(1);
  await expect(blocks(page).first()).toBeFocused();
  await page.keyboard.type('Dear {{');
  const pop = page.getByRole('dialog', { name: 'Insert variable' });
  await expect(pop).toBeVisible();
  await page.keyboard.type('first');
  await page.keyboard.press('Enter');
  await expect(pop).toBeHidden();
  await expect(blocks(page).first().locator('[data-field="talent.first_name"]')).toHaveCount(1);
  await expect(blocks(page).first()).toBeFocused();
  await page.keyboard.type(', thank you for applying.');

  // ⌘S saves the draft (POST …/versions: the first draft).
  await page.keyboard.press('ControlOrMeta+s');
  await toast(page, 'Draft saved.');
  expect(w.log).toContain('draft dt_01JBNEW1 v1');

  // ⌘⇧P previews the saved draft with the server's samples.
  await page.keyboard.press('ControlOrMeta+Shift+p');
  await expect(page.getByRole('region', { name: 'Preview pages' }).getByText('Amina')).toBeVisible();
  expect(w.log).toContain('preview dt_01JBNEW1_v1');

  // Publish v1 (every required check passes now).
  const publish = page.getByRole('button', { name: 'Publish v1…' });
  await activate(page, publish);
  await expect(dialog(page)).toBeVisible();
  await activate(page, dialog(page).getByRole('button', { name: 'Publish v1', exact: true }));
  await expect(dialog(page)).toBeHidden();
  await toast(page, 'v1 published. Tenants now get this version.');
  expect(w.log).toContain('publish dt_01JBNEW1_v1');

  // Withdraw with the default 7-day notice.
  await activate(page, page.getByRole('button', { name: 'More actions' }));
  await expect(page.getByRole('menu', { name: 'More actions' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Withdraw template…' })).toBeFocused();
  await expectFocusVisible(page);
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByLabel('Notice period (days)')).toHaveValue('7');
  await typeInto(page, dialog(page).getByLabel('Reason'), 'Replaced by the regional letters.');
  await expect(dialog(page).getByText('Takes effect 31 Oct 2026')).toBeVisible();
  await activate(page, dialog(page).getByRole('button', { name: 'Withdraw template' }));
  await expect(dialog(page)).toBeHidden();
  await toast(page, 'Withdrawal scheduled for 31 Oct 2026.');
  await expect(page.getByRole('status').filter({ hasText: 'Withdrawal pending.' })).toBeVisible();
  expect(w.log).toContain('withdraw dt_01JBNEW1 days=7 reason=Replaced by the regional letters.');
});

test('J11 · clear the unknown variable via Checks → insert a variable → reorder with ⌥↓ → compare → restore a version', async ({ page }) => {
  const w = new TemplateWorld();
  await openBuild(page, '/document-templates/dt_01J5OFFR', w.mock());

  // The readiness pill opens Checks; the unknown variable's fix removes it everywhere.
  await activate(page, page.getByRole('button', { name: /issues before publishing/ }));
  await expect(page.getByRole('tab', { name: /^Checks/ })).toHaveAttribute('aria-selected', 'true');
  const unknown = page.locator('.pws-check').filter({ hasText: 'Unknown variable {{offer.signing_bonus}}' });
  // The inspector is last in the tab order (after the outline, toolbar and every block).
  await tabTo(page, unknown.getByRole('button', { name: 'Remove from draft' }), { max: 250 });
  await page.keyboard.press('Enter');
  await toast(page, 'Removed {{offer.signing_bonus}} from the draft.');
  await expect(unknown).toHaveCount(0);
  await expect(page.locator('[data-field="offer.signing_bonus"]')).toHaveCount(0);

  // Insert a variable at the caret. (The design's "insert a section" step uses the
  // Sections library, which is the designed empty state here — directive R-13 — so
  // the journey inserts a variable through the {{ popover instead.)
  await tabTo(page, blocks(page).nth(1));
  await page.keyboard.press('End');
  await page.keyboard.type(' {{');
  await expect(page.getByRole('dialog', { name: 'Insert variable' })).toBeVisible();
  await page.keyboard.type('talent.email');
  await page.keyboard.press('Enter');
  await expect(blocks(page).nth(1).locator('[data-field="talent.email"]')).toHaveCount(1);

  // ⌥↓ moves the focused block down one place (and keeps it focused).
  const before = await blocks(page).nth(1).innerText();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(blocks(page).nth(2)).toHaveText(before);
  await expect(blocks(page).nth(2)).toBeFocused();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(blocks(page).nth(1)).toHaveText(before);

  // Compare the published version with the draft; Escape returns focus to Compare.
  await tabTo(page, page.getByRole('button', { name: 'Compare' }), { back: true, max: 120 });
  const compare = await focusedHandle(page);
  await page.keyboard.press('Enter');
  const cmp = page.getByRole('dialog', { name: 'Compare versions' });
  await expect(cmp).toBeVisible();
  await expect(cmp.getByLabel('Left version')).toHaveValue('dt_01J5OFFR_v3');
  await expect(cmp.locator('.pws-cmp__stat--chg')).toContainText('Changed');
  await page.keyboard.press('Escape');
  await expect(cmp).toBeHidden();
  await expectFocusReturned(page, compare);

  // Restore v2 into the draft from the Versions tab.
  await activate(page, page.getByRole('tab', { name: 'Versions' }));
  await activate(page, page.getByRole('button', { name: /^v2/ }));
  await expect(page.getByText('Viewing v2')).toBeVisible();
  await activate(page, page.getByRole('button', { name: 'Restore into draft…' }));
  await expect(dialog(page)).toBeVisible();
  await activate(page, dialog(page).getByRole('button', { name: 'Replace draft' }));
  await expect(dialog(page)).toBeHidden();
  await toast(page, 'Draft replaced with v2. Save and preview before publishing.');
  await expect(blocks(page)).toHaveCount(8);
  await page.keyboard.press('ControlOrMeta+s');
  await toast(page, 'Draft saved.');
  expect(w.log).toContain('save dt_01J5OFFR_v4');
});

test('Studio drag and drop (pointer): a block moves to the drop line; a variable card drops into a block', async ({ page }) => {
  const w = new TemplateWorld();
  await openBuild(page, '/document-templates/dt_01J5OFFR', w.mock());
  const first = await blocks(page).nth(0).innerText();
  await blocks(page).nth(0).hover();
  // Drag the first block's ⋮⋮ grip below the third block (the lower half of its row).
  const target = page.locator('[data-row]').nth(2);
  const box = (await target.boundingBox())!;
  await page.getByRole('button', { name: 'Block options' }).nth(0).dragTo(target, { targetPosition: { x: 40, y: box.height - 4 } });
  await expect(blocks(page).nth(2)).toHaveText(first);
  // A variable card from the inspector drops into the block under the pointer.
  const card = page.locator('.pws-vcard').filter({ hasText: 'talent.email' });
  await card.dragTo(blocks(page).nth(0), { targetPosition: { x: 20, y: 10 } });
  await expect(blocks(page).nth(0).locator('[data-field="talent.email"]')).toHaveCount(1);
  await expect(page.getByText('Inserted {{talent.email}}.').first()).toBeVisible();
});
