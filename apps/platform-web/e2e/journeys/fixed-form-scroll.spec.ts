// FIELD-PARITY-1 P0-1 (Sign Field Placement Enterprise Parity Directive v1.0 LOCKED §3.1) — the
// fixed-form Studio on a 3-page form: only the page column and the side panels scroll (R-1),
// the target page follows the view (R-2), a new field lands on the page in view (R-3), and the
// stacked layout still renders at 1000px (R-4). The 3-page PDF is generated (pdf-lib) and served
// by the fixture provider with the fixed-form routes (e2e/fixtures/fixed-form.ts).

import { expect, test, type Page } from '@playwright/test';

import { openFixedFormStudio } from '../fixtures/fixed-form';

const openStudio = (page: Page) => openFixedFormStudio(page, { templateId: 'dt_ff3page', title: 'Three-page form', pages: 3 });

/** The rect of `sel` relative to the viewport. */
const rectOf = (page: Page, testId: string) =>
  page.getByTestId(testId).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });

test('P0-1 · scrolling the page column to page 3 keeps the panels in view; a new Text field lands on page 3 where the operator is looking', async ({ page }) => {
  await openStudio(page);
  const note = page.getByText(/Fields are added to page \d+\./);
  await expect(note).toHaveText(/page 1\./);

  // R-1 — scroll the page column (mouse wheel over it) to the last page.
  const center = page.getByTestId('ffs-center');
  await center.hover();
  for (let i = 0; i < 12; i += 1) await page.mouse.wheel(0, 400);
  await expect.poll(() => center.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // R-2 — the target page follows the view.
  await expect(note).toHaveText(/page 3\./);

  // The window never scrolled; the top bar, the field buttons and the right panel are in view.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByRole('button', { name: 'Save' })).toBeInViewport();
  await expect(page.getByRole('heading', { name: 'Place a field' })).toBeInViewport();
  await expect(page.getByTestId('ffs-add-TEXT')).toBeInViewport();
  await expect(page.getByRole('complementary', { name: 'Field and checks' })).toBeInViewport();
  await expect(page.getByRole('heading', { name: 'Checks' })).toBeInViewport();

  // R-3 — Text lands on page 3, inside the visible part of the column.
  await page.getByTestId('ffs-add-TEXT').click();
  const field = page.getByTestId('ffs-page-2').getByTestId('ffs-field-text_1');
  await expect(field).toBeVisible();
  await expect(field).toBeInViewport({ ratio: 1 });
  const f = await rectOf(page, 'ffs-field-text_1');
  const c = await rectOf(page, 'ffs-center');
  const p3 = await rectOf(page, 'ffs-page-2');
  expect(f.top).toBeGreaterThanOrEqual(Math.max(c.top, p3.top));
  expect(f.bottom).toBeLessThanOrEqual(Math.min(c.bottom, p3.bottom));
  expect(f.left).toBeGreaterThanOrEqual(p3.left);
  expect(f.right).toBeLessThanOrEqual(p3.right);
  await expect(page.getByTestId('ffs-inspector')).toContainText('page 3');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('P0-1 · at 1000px the stacked one-column layout still renders, with normal page scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await openStudio(page);
  const setup = await page.getByRole('complementary', { name: 'Form setup' }).evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  const c = await rectOf(page, 'ffs-center');
  const right = await page.getByRole('complementary', { name: 'Field and checks' }).evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  // One column: setup panel, then the pages, then the field panel — stacked, same left edge.
  expect(Math.round(c.left)).toBe(Math.round(setup.left));
  expect(Math.round(right.left)).toBe(Math.round(setup.left));
  expect(c.top).toBeGreaterThanOrEqual(setup.bottom - 1);
  expect(right.top).toBeGreaterThanOrEqual(c.bottom - 1);
  // The document itself is taller than the window (the window scrolls, not the column).
  expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);
});
