// TEMPLATE-STUDIO-1 (PO/Lead scope ruling 2026-10-27) — visual baselines of the
// Organization Template Studio and the Template gallery (home-web /org/document-templates),
// at 1440×900 and 900×900, on the mocked tenant API (org-studio-fixtures.ts) and a frozen
// clock. Mirrors apps/platform-web/e2e/visual (deterministic fonts, no animation, no
// caret, the pointer parked). Unlike the platform suite these baselines are recordings of
// the BUILD (there is no organization design-file harness): a change to the Org Studio's
// pixels must be re-recorded deliberately (`--update-snapshots`) and explained.
//
// Every state also asserts its behaviour (the Outline never shows a {{key}}; the preview
// page fits the column; the gallery preview hides the edit chrome; the author never sees
// Approve), so a re-record cannot silently bless a regression.

import { expect, test, type Page } from '@playwright/test';

import { ARAMO_DEFAULT, AUTHOR_SCOPES, MANAGER_SCOPES, NOW_ISO, libraryItem, mockOrgApi, type OrgWorld } from './org-studio-fixtures';

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '900', width: 900, height: 900 },
] as const;

const FACES = [...[400, 500, 600, 700].map((w) => `${w} 14px "Hanken Grotesk"`), ...[400, 500].map((w) => `${w} 14px "IBM Plex Mono"`)];
const GLYPHS = 'Aa0 €£ ÄÖÜßéñ’“” …·–—→←↑↓⇄↵↶↷⌘⌥⇧✓×⋮⋯▣';

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => Array.from(document.fonts).some((f) => f.family.replace(/"/g, '') === 'Hanken Grotesk'), null, { timeout: 30_000 });
  await page.evaluate(
    async ([faces, sample]) => {
      await Promise.all(faces.map((f) => document.fonts.load(f, sample)));
      await document.fonts.ready;
    },
    [FACES, GLYPHS] as const,
  );
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
}

async function open(page: Page, world: OrgWorld, path: string): Promise<void> {
  await page.clock.setFixedTime(new Date(NOW_ISO));
  await mockOrgApi(page, world);
  await page.goto(path);
}

const manager = (items: unknown[] = [ARAMO_DEFAULT]): OrgWorld => ({ libraryItems: items, scopes: MANAGER_SCOPES });

async function expectOutlineReadable(page: Page): Promise<void> {
  // Below 1280px the Outline panel starts closed (handoff §2): nothing to read.
  if ((page.viewportSize()?.width ?? 0) < 1280) return;
  const rows = await page.locator('.pws-orow__l').allTextContents();
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) expect(r).not.toMatch(/\{\{|\}\}/);
}

async function expectPreviewFits(page: Page): Promise<void> {
  const region = await page.getByRole('region', { name: 'Preview pages' }).boundingBox();
  const art = await page.locator('article[aria-label="Page 1"]').boundingBox();
  expect(region).not.toBeNull();
  expect(art).not.toBeNull();
  if (region === null || art === null) return;
  expect(art.x).toBeGreaterThanOrEqual(region.x);
  expect(art.x + art.width).toBeLessThanOrEqual(region.x + region.width);
  await expect(page.getByRole('button', { name: 'Fit to width' })).toHaveAttribute('aria-pressed', 'true');
}

interface OrgState {
  readonly name: string;
  readonly go: (page: Page) => Promise<void>;
}

const STATES: readonly OrgState[] = [
  {
    name: 'org-gallery',
    go: async (page) => {
      await open(page, manager(), '/org/document-templates/gallery');
      await page.getByTestId(`gallery-card-${ARAMO_DEFAULT.id}`).waitFor();
    },
  },
  {
    name: 'org-default-preview',
    go: async (page) => {
      await open(page, manager(), '/org/document-templates/aramo/def-rtr');
      await page.getByTestId('studio-adopt').waitFor();
      await page.locator('article[aria-label="Page 1"]').waitFor();
      // Read-only Aramo default: Preview + Adopt only — no mode toggle, readiness, Checks or usage counts.
      await expect(page.getByRole('group', { name: 'Mode' })).toHaveCount(0);
      await expect(page.getByTitle('Publishing checks')).toHaveCount(0);
      await expect(page.getByRole('tab', { name: /Checks/ })).toHaveCount(0);
      await expect(page.locator('.pws-vcard__used')).toHaveCount(0);
      await expectOutlineReadable(page);
      await expectPreviewFits(page);
    },
  },
  {
    name: 'org-adopt-confirm',
    go: async (page) => {
      await open(page, manager(), '/org/document-templates/aramo/def-rtr');
      await page.getByTestId('studio-adopt').click();
      await page.getByTestId('gallery-adopt-modal').waitFor();
    },
  },
  {
    name: 'org-studio-edit',
    go: async (page) => {
      const items = [ARAMO_DEFAULT, libraryItem({ id: 'tpl-new', name: 'Aramo Right to Represent', status: 'DRAFT', current_version_id: null, current_version_number: null })];
      await open(page, manager(items), '/org/document-templates/tpl-new');
      await page.locator('.pws-doc [data-block-id]').first().waitFor();
      await expect(page.getByRole('group', { name: 'Mode' })).toHaveCount(1);
      await expectOutlineReadable(page);
    },
  },
  {
    name: 'org-studio-preview-fit',
    go: async (page) => {
      await open(page, manager(), '/org/document-templates/tpl-1');
      await page.getByRole('button', { name: /Approve/ }).waitFor();
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      await page.locator('article[aria-label="Page 1"]').waitFor();
      await expectPreviewFits(page);
    },
  },
  {
    name: 'org-our-templates-new-version',
    go: async (page) => {
      const items = [ARAMO_DEFAULT, libraryItem({ id: 'tpl-2', name: 'Astre Right to Represent', current_version_id: 'v2', current_version_number: 2 })];
      await open(page, manager(items), '/org/document-templates');
      await page.getByTestId('our-template-new-version-tpl-2').waitFor();
    },
  },
  {
    name: 'org-approve-dialog',
    go: async (page) => {
      await open(page, manager(), '/org/document-templates/tpl-1');
      await page.getByRole('button', { name: /Approve/ }).waitFor();
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      await page.locator('article[aria-label="Page 1"]').waitFor();
      await page.getByRole('button', { name: /Approve/ }).click();
      await page.getByRole('dialog').waitFor();
    },
  },
  {
    name: 'org-studio-author',
    go: async (page) => {
      await open(page, { libraryItems: [ARAMO_DEFAULT], scopes: AUTHOR_SCOPES }, '/org/document-templates/tpl-1');
      await page.locator('.pws-doc [data-block-id]').first().waitFor();
      if ((page.viewportSize()?.width ?? 0) >= 1280) await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();
      await expect(page.getByRole('button', { name: /Approve/ })).toHaveCount(0);
      await expectOutlineReadable(page);
    },
  },
];

const ONLY = process.env['PW_STATE'];

for (const s of STATES) {
  if (ONLY && !s.name.includes(ONLY)) continue;
  for (const vp of VIEWPORTS) {
    test(`${s.name} @${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await s.go(page);
      await page.mouse.move(vp.width - 1, vp.height - 1);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await settle(page);
      // The save status reads the wall clock ("Saved · HH:MM"): masked.
      await expect(page).toHaveScreenshot(`${s.name}-${vp.name}.png`, { mask: [page.locator('.pws-top__save')] });
    });
  }
}
