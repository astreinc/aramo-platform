// FIELD-PARITY-1 §5 P2-1 / P2-2 / P2-3 (Sign Field Placement Enterprise Parity Directive v1.0
// LOCKED; §8 item 6 "console Studio fixed-form journeys: … repeat down, align") — in the
// console's fixed-form Studio (the shared placement editor): build one attendee row, Repeat it
// down nine times as one undo step, then line a column back up with Align left, with undo and
// redo by button and by keyboard.

import { expect, test, type Page } from '@playwright/test';

import { openFixedFormStudio } from '../fixtures/fixed-form';

const openStudio = (page: Page) => openFixedFormStudio(page, { templateId: 'dt_ffminutes', title: 'Meeting minutes', pages: 1 });
const leftOf = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => el.getBoundingClientRect().left);
const fields = (page: Page) => page.getByTestId('ffs-page-0').locator('[data-field-id]');

test('P2-1 · Repeat down: one attendee row (text + check box) nine times is one undo step', async ({ page }) => {
  await openStudio(page);
  await page.getByTestId('ffs-add-TEXT').click();
  await page.getByTestId('ffs-add-CHECKBOX').click();
  await expect(fields(page)).toHaveCount(2);

  // The row: the text field, then Shift+click the check box.
  await page.getByTestId('ffs-field-text_1').click();
  await page.getByTestId('ffs-field-checkbox_1').click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('ffs-selection-count')).toHaveText(/2 fields selected/);

  await page.getByTestId('ffs-repeat-count').fill('9');
  await page.getByTestId('ffs-repeat-pitch').fill('30');
  await page.getByTestId('ffs-repeat').click();
  await expect(page.getByTestId('ffs-announce')).toHaveText('9 rows added.');
  await expect(fields(page)).toHaveCount(20);
  await expect(page.getByTestId('ffs-field-text_10')).toBeVisible();
  await expect(page.getByTestId('ffs-field-checkbox_10')).toBeVisible();

  // One undo removes all nine rows; redo brings them back.
  await page.getByTestId('ffs-undo').click();
  await expect(fields(page)).toHaveCount(2);
  await page.getByTestId('ffs-redo').click();
  await expect(fields(page)).toHaveCount(20);
  await expect(page.getByTestId('ffs-announce')).toHaveText('Redone: Repeat down 9 rows.');
});

test('P2-2 / P2-3 · Align left lines a column back up; Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z undo and redo it', async ({ page }) => {
  await openStudio(page);
  await page.getByTestId('ffs-add-TEXT').click();
  await page.getByTestId('ffs-field-text_1').click();
  await page.getByTestId('ffs-repeat-count').fill('2');
  await page.getByTestId('ffs-repeat-pitch').fill('40');
  await page.getByTestId('ffs-repeat').click();
  await expect(fields(page)).toHaveCount(3);

  // Knock the middle one out of line from the keyboard (Shift+→ twice: 20pt). A click on the
  // empty page corner clears the selection (source row + new rows) first.
  await page.getByTestId('ffs-page-0').click({ position: { x: 4, y: 4 } });
  await page.getByTestId('ffs-field-text_2').click();
  await page.getByTestId('ffs-field-text_2').focus();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  const l1 = await leftOf(page, 'ffs-field-text_1');
  expect(await leftOf(page, 'ffs-field-text_2')).toBeGreaterThan(l1 + 5);

  // Select the column (click, then Shift+click) and align left.
  await page.getByTestId('ffs-field-text_1').click();
  await page.getByTestId('ffs-field-text_2').click({ modifiers: ['Shift'] });
  await page.getByTestId('ffs-field-text_3').click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('ffs-selection-count')).toHaveText(/3 fields selected/);
  await page.getByRole('button', { name: 'Align left' }).click();
  await expect(page.getByTestId('ffs-announce')).toHaveText('3 fields aligned left.');
  await expect.poll(() => leftOf(page, 'ffs-field-text_2')).toBeCloseTo(l1, 0);

  // Undo / redo from the keyboard (focus is on the page column, not a text control).
  await page.getByTestId('ffs-field-text_1').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => leftOf(page, 'ffs-field-text_2')).toBeGreaterThan(l1 + 5);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => leftOf(page, 'ffs-field-text_2')).toBeCloseTo(l1, 0);

  // Snap is on by default; the grid is optional.
  await expect(page.getByTestId('ffs-snap')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('ffs-grid')).toHaveAttribute('aria-pressed', 'false');
});
