// FIELD-PARITY-1 P0-1 (Sign Field Placement Enterprise Parity Directive v1.0 LOCKED §3.1) — the
// fixed-form Studio on a 3-page form: only the page column and the side panels scroll (R-1),
// the target page follows the view (R-2), a new field lands on the page in view (R-3), and the
// stacked layout still renders at 1000px (R-4). The 3-page PDF is generated here (pdf-lib) and
// served by the fixture provider with the fixed-form routes.

import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import type { MockOptions } from '../fixtures/mock-api';
import { openBuild } from '../support/build';

const TEMPLATE_ID = 'dt_ff3page';
const VERSION_ID = 'dt_ff3page_v1';
const PAGE = { width: 612, height: 792 };

async function threePagePdf(): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i += 1) {
    const p = doc.addPage([PAGE.width, PAGE.height]);
    p.drawText(`Official form · page ${i} of 3`, { x: 72, y: PAGE.height - 72, size: 18, font });
  }
  // Fixed dates keep the bytes deterministic.
  doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  doc.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  return Buffer.from(await doc.save()).toString('base64');
}

function fixedFormMock(pdfBase64: string): MockOptions {
  const at = '2026-10-01T00:00:00.000Z';
  const view = {
    template_id: TEMPLATE_ID,
    version_id: VERSION_ID,
    version_number: 1,
    status: 'DRAFT',
    content: {
      render_schema_version: 'fixed-form-pdf-v1',
      title: 'Three-page form',
      pdf: { asset_id: 'asset_ff3', sha256: 'a'.repeat(64), byte_size: Math.floor((pdfBase64.length * 3) / 4), page_count: 3, pages: [PAGE, PAGE, PAGE] },
      signing: { roles: [{ role_key: 'employee', label: 'Employee', kind: 'SIGNER', order: 1 }], routing_mode: 'PARALLEL' },
    },
    fields: [],
    variables: [],
    issues: [{ code: 'fields_required', message: 'Place at least one field.' }],
    previewed: false,
  };
  return {
    overrides: [
      {
        path: /^\/platform\/document-templates\/document-types$/,
        reply: {
          body: {
            document_types: [{ id: 'dty_ff3', key: 'FF3', name: 'Three-page form', configurable: false, template_kind: 'FIXED_FORM', products: ['sign'], category: 'Employment' }],
          },
        },
      },
      {
        path: new RegExp(`^/platform/document-templates/${TEMPLATE_ID}$`),
        reply: {
          body: {
            id: TEMPLATE_ID,
            owner_scope: 'PLATFORM',
            document_type_id: 'dty_ff3',
            name: 'Three-page form',
            description: null,
            template_kind: 'UPLOADED_PDF',
            status: 'DRAFT',
            products: ['sign'],
            current_version: null,
            draft_version_id: VERSION_ID,
            withdraw_notice_at: null,
            withdraw_effective_at: null,
            created_at: at,
            updated_at: at,
            versions: [],
          },
        },
      },
      { path: new RegExp(`^/platform/document-templates/versions/${VERSION_ID}/fixed-form$`), reply: { body: view } },
      { path: new RegExp(`^/platform/document-templates/versions/${VERSION_ID}/fixed-form/pdf$`), reply: { body: { sha256: 'a'.repeat(64), byte_size: view.content.pdf.byte_size, content_base64: pdfBase64 } } },
    ],
  };
}

async function openStudio(page: Page): Promise<void> {
  // The renderer's worker is imported as `pdfjs-dist/build/pdf.worker.min.mjs?url`. The Vite dev
  // server answers that with `export default "<url>"` only when node_modules sits inside the
  // workspace root; with node_modules linked from outside it (a git worktree) it serves the raw
  // worker and pdf.js refuses it. Answer the import as Vite does in a plain checkout.
  await page.route(/pdf\.worker\.min\.mjs\?url$/, (route) => {
    const u = new URL(route.request().url());
    return route.fulfill({ contentType: 'text/javascript', body: `export default ${JSON.stringify(u.pathname)};` });
  });
  await openBuild(page, `/document-templates/${TEMPLATE_ID}`, fixedFormMock(await threePagePdf()));
  await expect(page.getByTestId('fixed-form-studio')).toBeVisible();
  await expect(page.getByTestId('ffs-page-2')).toBeVisible();
}

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
