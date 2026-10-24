// PLATFORM-UX-1 H-1 — the template library and the Template Studio (handoff §10;
// directive R-10–R-13), against Template Studio.dc.html. The design file opens on the
// Offer letter in edit mode; every Studio state starts from the save state it shows
// when a template is opened from the library ("Saved · —", rev 1: openStudio()).

import type { Page } from '@playwright/test';

import { detailOverride, emptyDraft, previewedDraft, studioMock } from '../fixtures/templates';
import type { Mask, ScreenState } from './state-types';

const OFFER = 'dt_01J5OFFR';
const NDA = 'dt_01J5NDA0';
const INTV = 'dt_01J5INTV';
const CONT = 'dt_01J5CONT';

/** openStudio()'s save state: opened from the library, nothing saved in this session. */
const OPENED = { save: { state: 'saved', at: '—', rev: 1 } };

const studio = (id: string, state: Record<string, unknown> = {}, extra: { call?: string; act?: (p: Page) => Promise<void>; studio?: { persona?: 'manager' | 'reader' } } = {}) => ({
  file: 'studio' as const,
  hash: id,
  state: { ...OPENED, ...state },
  ...(extra.studio ? { studio: extra.studio } : {}),
  ...(extra.call ? { call: extra.call } : {}),
  ...(extra.act ? { act: extra.act } : {}),
});

// ---- masks (DIVERGENCES.md) --------------------------------------------------------

/** DV-20 — the Studio file's rail draws three icons in an older style; the shell rail is Platform Admin.dc.html's. */
const RAIL_ICONS: readonly Mask[] = [
  ['Tenants', '/tenants'],
  ['Review queue', '/personal-review'],
  ['Platform admins', '/admins'],
].map(([title, href]) => ({
  proto: (p: Page) => p.locator(`nav[aria-label="Platform admin"] a[title="${title}"] svg`).first(),
  build: (p: Page) => p.locator(`.rc-rail a[href="${href}"] svg`),
  divergence: 'DV-20',
}));

/** DV-21 — the library's top bar is the console top bar (crumb style, ⌘K search). */
const LIB_TOPBAR: readonly Mask[] = [
  { proto: (p) => p.locator('header nav[aria-label="Breadcrumb"]'), build: (p) => p.locator('.pw-crumbs'), divergence: 'DV-21', padRight: 40 },
  // From the ⌘K search's left edge to the PLATFORM tag's right edge.
  { proto: (p) => p.locator('header > span').filter({ hasText: 'PLATFORM' }), build: (p) => p.locator('.pw-cmdk-trigger, .rc-topbar .pw-topbar-mark'), divergence: 'DV-21', padLeft: 330, padTop: 8, padBottom: 8 },
];

/** DV-22 — the library Draft column has no block count (the list DTO carries no content). */
const LIB_DRAFT: Mask = {
  proto: (p) => p.locator('tbody tr td:nth-child(3)'),
  build: (p) => p.locator('tbody tr td:nth-child(3)'),
  divergence: 'DV-22',
  viewport: '1440',
};
/** DV-22 at 900px: the shorter Draft cells re-flow the auto table layout. */
const LIB_TABLE: Mask = {
  proto: (p) => p.locator('main table').first(),
  build: (p) => p.locator('.pws-lib__table'),
  divergence: 'DV-22',
  toBottom: true,
  viewport: '900',
};

/** DV-23 — the reader persona: the Studio file keeps the operator's identity. */
const READER_IDENTITY: readonly Mask[] = [
  { proto: (p) => p.locator('[role="banner"] > span').nth(2), build: (p) => p.getByTestId('envbar-identity'), divergence: 'DV-23', padLeft: 80 },
  // The rail is filtered by the persona's permissions in the build (handoff §3.3); the Studio file lists every page.
  { proto: (p) => p.locator('nav[aria-label="Platform admin"]'), build: (p) => p.locator('.rc-rail'), divergence: 'DV-23' },
  { proto: (p) => p.locator('nav[aria-label="Platform admin"] > div').last(), build: (p) => p.locator('.rc-rail__foot'), divergence: 'DV-23' },
  { proto: (p) => p.locator('button[aria-label="Account"] > span').first(), build: (p) => p.locator('.pw-account__trigger .pw-account__avatar'), divergence: 'DV-23' },
];

/** DV-24 — the library's view-only note (handoff §16.3): the Studio file's library has none. */
const LIB_VIEWONLY: Mask = {
  proto: (p) => p.locator('main > div').nth(1),
  build: (p) => p.locator('.pws-lib__note'),
  divergence: 'DV-24',
  toBottom: true,
};

/** DV-25 — the Sections tab is the designed empty state (R-13: no shared section library). */
const SECTIONS_BODY: Mask = {
  proto: (p) => p.locator('aside[aria-label="Template structure"] > div').nth(1),
  build: (p) => p.locator('.pws-left__body'),
  divergence: 'DV-25',
};

/** DV-26 — read-only renders (version view, :read preview) draw variables through SafeDoc (label chips). */
const RO_DOC = (sel: string): Mask => ({
  proto: (p) => p.locator(sel).first(),
  build: (p) => p.locator('.pws-page--ro .dt-doc, .pws-pvpage__body .dt-doc').first(),
  divergence: 'DV-26',
  toBottom: true,
});

/** DV-27 — the preview footer names the draft version ("Draft · vN"), not the session save rev. */
const PREVIEW_FOOT: Mask = {
  proto: (p) => p.getByText(/· Draft · rev \d+/).first(),
  build: (p) => p.locator('.pws-pvpage__foot .pws-mono').first(),
  divergence: 'DV-27',
  textBox: true,
  padRight: 12,
};

/** DV-28 — "Long values" is disabled (the server has no long sample set). */
const LONG_VALUES: Mask = {
  proto: (p) => p.getByRole('button', { name: 'Long values' }),
  build: (p) => p.getByRole('button', { name: 'Long values' }),
  divergence: 'DV-28',
};

/** DV-29 — the pending-withdrawal bar has no reason (the template DTO carries none). */
const WD_REASON: Mask = {
  proto: (p) => p.locator('[role="status"]').filter({ hasText: 'Withdrawal pending.' }),
  build: (p) => p.locator('.pws-bar--warn'),
  divergence: 'DV-29',
};

/**
 * DV-30 — the :read Studio describes the PUBLISHED version (R-13: :read sees the
 * published version only): its outline, variable usage and checks are the published
 * version's, where the design file's describe the draft.
 */
const READER_PANELS: readonly Mask[] = [
  { proto: (p) => p.locator('button[title="Publishing checks"]'), build: (p) => p.locator('.pws-top [role="group"][aria-label="Mode"], .pws-ready'), divergence: 'DV-30', padLeft: 170 },
  { proto: (p) => p.locator('aside[aria-label="Template structure"] > div').nth(1), build: (p) => p.locator('.pws-left__body'), divergence: 'DV-30' },
  { proto: (p) => p.locator('aside[aria-label="Inspector"]'), build: (p) => p.locator('.pws-right'), divergence: 'DV-30' },
  // No sample render for :read, so the page header has no organization sample value.
  { proto: (p) => p.locator('article').first().locator(':scope > div').first().locator('span').first(), build: (p) => p.locator('.pws-pvpage__org').first(), divergence: 'DV-30', textBox: true, padRight: 4 },
];

/** DV-31 — the plain (unhighlighted) preview: each sample value is its own span (the shared SafeDoc), so text shapes per run. */
const PLAIN_BODY: Mask = {
  proto: (p) => p.locator('article').first().locator(':scope > div').nth(1),
  build: (p) => p.locator('.pws-pvpage__body').first(),
  divergence: 'DV-31',
};

const STUDIO = [...RAIL_ICONS];
const LIB = [...RAIL_ICONS, ...LIB_TOPBAR];

// ---- build actions -----------------------------------------------------------------

const block = (p: Page, i: number) => p.locator('[data-block-id]').nth(i);
/**
 * The panel toggles sit at the ends of the formatting toolbar, which overflows its
 * scroller below 1440: a dispatched click leaves the toolbar unscrolled, as in the
 * design file's state (a real click would scroll the toggle into view first).
 */
const toggle = (p: Page, name: string) => p.getByRole('button', { name }).dispatchEvent('click');
const LEFT_TABS = ['Outline', 'Sections', 'Versions'];
/** Opens the tab; below 1280 / 1100 the panel is a closed overlay, so it is opened first. */
const tab = async (p: Page, name: string): Promise<void> => {
  const left = LEFT_TABS.includes(name);
  const panel = p.getByRole('complementary', { name: left ? 'Template structure' : 'Inspector' });
  if ((await panel.count()) === 0) await toggle(p, left ? 'Toggle outline' : 'Toggle inspector');
  await p.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
};
const more = (p: Page) => p.getByRole('button', { name: 'More actions' }).click();
/** Two edits that leave the title as it was: the draft is dirty, the page unchanged. */
const dirtyTitle = async (p: Page): Promise<void> => {
  const t = p.locator('.pws-page__title-in');
  const v = await t.inputValue();
  await t.fill(`${v}x`);
  await t.fill(v);
};
const autosaveOff = async (p: Page): Promise<void> => {
  await more(p);
  await p.getByRole('menuitem', { name: /Autosave drafts/ }).click();
};
const newEmptyBlock = async (p: Page, after: number): Promise<void> => {
  await block(p, after).hover();
  await p.getByRole('button', { name: 'Add block below' }).nth(after).click();
};

// ---- the catalog -------------------------------------------------------------------

export const STUDIO_STATES: readonly ScreenState[] = [
  // ---- library (handoff §10.1) ----------------------------------------------------
  { name: 'lib', proto: { file: 'studio', hash: 'library' }, build: { path: '/document-templates', mock: studioMock() }, masks: [...LIB, LIB_DRAFT, LIB_TABLE] },
  {
    name: 'lib-filtered',
    proto: { file: 'studio', hash: 'library', state: { libTag: 'SIGN' } },
    build: { path: '/document-templates', mock: studioMock(), act: (p) => p.getByRole('group', { name: 'Product' }).getByRole('button', { name: 'SIGN' }).click() },
    masks: [...LIB, LIB_DRAFT, LIB_TABLE],
  },
  {
    name: 'lib-empty',
    blur: true,
    proto: { file: 'studio', hash: 'library', state: { libQ: 'zzz' } },
    build: { path: '/document-templates', mock: studioMock(), act: (p) => p.getByLabel('Search templates').fill('zzz') },
    masks: LIB,
  },
  {
    name: 'lib-viewonly',
    proto: { file: 'studio', hash: 'library', studio: { persona: 'reader' } },
    build: { path: '/document-templates', mock: studioMock({ persona: 'auditor' }) },
    masks: [...LIB, ...READER_IDENTITY, LIB_VIEWONLY],
  },
  {
    name: 'lib-create',
    blur: true,
    proto: { file: 'studio', hash: 'library', call: 'c.renderVals().lib.create()' },
    build: { path: '/document-templates', mock: studioMock(), act: (p) => p.getByRole('button', { name: '+ Create default template' }).click() },
    masks: [...LIB, LIB_DRAFT, LIB_TABLE],
  },
  {
    name: 'lib-create-copy',
    blur: true,
    proto: { file: 'studio', hash: 'library', call: "c.renderVals().lib.create(); c.setDv('type', 'Offer letter'); c.setDv('name', 'Offer letter DE'); c.setDv('start', 'copy:dt_01J5OFFR')" },
    build: {
      path: '/document-templates',
      mock: studioMock(),
      act: async (p) => {
        await p.getByRole('button', { name: '+ Create default template' }).click();
        await p.getByLabel('Document type').selectOption({ label: 'Offer letter' });
        await p.getByLabel('Name').fill('Offer letter DE');
        await p.getByLabel('Start from').selectOption(`copy:${OFFER}`);
      },
    },
    masks: [...LIB, LIB_DRAFT, LIB_TABLE],
  },
  // ---- Studio, edit mode (§10.2–10.5) --------------------------------------------
  { name: 'studio', proto: studio(OFFER), build: { path: `/document-templates/${OFFER}`, mock: studioMock() }, masks: STUDIO },
  {
    name: 'studio-block-selected',
    proto: studio(OFFER, { sel: 'b103' }),
    build: { path: `/document-templates/${OFFER}`, mock: studioMock(), act: (p) => block(p, 2).click({ position: { x: 4, y: 4 } }) },
    masks: STUDIO,
  },
  {
    name: 'studio-block-menu',
    proto: studio(OFFER, {}, { act: (p) => p.getByRole('button', { name: 'Block options' }).nth(2).click({ force: true }) }),
    build: { path: `/document-templates/${OFFER}`, mock: studioMock(), act: (p) => p.getByRole('button', { name: 'Block options' }).nth(2).click({ force: true }) },
    masks: STUDIO,
  },
  {
    name: 'studio-slash-menu',
    proto: studio(OFFER, {}, { act: async (p) => { await p.getByRole('button', { name: 'Add block below' }).nth(2).click({ force: true }); await p.keyboard.press('/'); } }),
    build: { path: `/document-templates/${OFFER}`, mock: studioMock(), act: async (p) => { await newEmptyBlock(p, 2); await p.keyboard.press('/'); } },
    masks: STUDIO,
  },
  {
    name: 'studio-var-popover',
    proto: studio(OFFER, {}, { act: async (p) => { await p.getByRole('button', { name: 'Add block below' }).nth(2).click({ force: true }); await p.keyboard.type('{{'); } }),
    build: { path: `/document-templates/${OFFER}`, mock: studioMock(), act: async (p) => { await newEmptyBlock(p, 2); await p.keyboard.type('{{'); } },
    masks: STUDIO,
  },
  {
    name: 'studio-float-toolbar',
    proto: studio(OFFER, {}, { act: (p) => p.locator('[data-block="b103"]').getByText('pleased', { exact: false }).first().dblclick({ position: { x: 90, y: 8 } }) }),
    build: { path: `/document-templates/${OFFER}`, mock: studioMock(), act: (p) => block(p, 2).dblclick({ position: { x: 90, y: 8 } }) },
    masks: STUDIO,
  },
  {
    name: 'studio-drag',
    proto: studio(OFFER, { dragging: true, drop: { id: 'b104', pos: 'before' } }),
    build: {
      path: `/document-templates/${OFFER}`,
      mock: studioMock(),
      act: (p) =>
        p.evaluate(() => {
          const dt = new DataTransfer();
          const grips = document.querySelectorAll('[aria-label="Block options"]');
          grips[1]!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
          const row = document.querySelectorAll('[data-row]')[3] as HTMLElement;
          const r = row.getBoundingClientRect();
          row.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.top + 2 }));
        }),
    },
    masks: STUDIO,
  },
  {
    name: 'studio-more-menu',
    proto: studio(OFFER, { more: true }),
    build: { path: `/document-templates/${OFFER}`, mock: studioMock(), act: more },
    masks: STUDIO,
  },
  // ---- panels (§10.3, §10.6) -------------------------------------------------------
  {
    name: 'studio-sections',
    proto: studio(OFFER, { leftTab: 'sections', leftOpen: true }),
    build: { path: `/document-templates/${OFFER}`, mock: studioMock(), act: (p) => tab(p, 'Sections') },
    masks: [...STUDIO, SECTIONS_BODY],
  },
  {
    name: 'studio-versions',
    proto: studio(OFFER, { leftTab: 'versions', leftOpen: true }),
    build: { path: `/document-templates/${OFFER}`, mock: studioMock(), act: (p) => tab(p, 'Versions') },
    masks: STUDIO,
  },
  {
    name: 'studio-properties',
    proto: studio(OFFER, { rightTab: 'properties', rightOpen: true }),
    build: { path: `/document-templates/${OFFER}`, mock: studioMock(), act: (p) => tab(p, 'Properties') },
    masks: STUDIO,
  },
  {
    name: 'studio-checks',
    proto: studio(OFFER, { rightTab: 'checks', rightOpen: true }),
    build: { path: `/document-templates/${OFFER}`, mock: studioMock(), act: (p) => tab(p, 'Checks') },
    masks: STUDIO,
  },
  {
    name: 'studio-checks-ready',
    proto: studio(INTV, { rightTab: 'checks', previewedRev: 1, rightOpen: true }),
    build: { path: `/document-templates/${INTV}`, mock: studioMock({ overrides: [detailOverride(INTV, previewedDraft)] }), act: (p) => tab(p, 'Checks') },
    masks: STUDIO,
  },
  // ---- save states (§10.7) -----------------------------------------------------------
  {
    name: 'studio-unsaved',
    blur: true,
    proto: studio(OFFER, { dirty: true, save: { state: 'unsaved', at: '—', rev: 1 } }),
    build: {
      path: `/document-templates/${OFFER}`,
      mock: studioMock(),
      act: async (p) => {
        await autosaveOff(p);
        await dirtyTitle(p);
      },
    },
    masks: STUDIO,
  },
  {
    name: 'studio-saving',
    blur: true,
    proto: studio(OFFER, { dirty: true, save: { state: 'saving', at: '—', rev: 1 } }),
    build: {
      path: `/document-templates/${OFFER}`,
      mock: studioMock({ overrides: [{ method: 'PATCH', path: /^\/platform\/document-templates\/versions\//, reply: 'hang' }] }),
      act: async (p) => {
        await autosaveOff(p);
        await dirtyTitle(p);
        await p.keyboard.press('ControlOrMeta+s');
      },
    },
    masks: STUDIO,
  },
  {
    name: 'studio-saved',
    blur: true,
    proto: studio(OFFER, { save: { state: 'saved', at: '15:00:00', rev: 2 }, toast: 'Draft saved.' }),
    build: {
      path: `/document-templates/${OFFER}`,
      mock: studioMock(),
      act: async (p) => {
        await autosaveOff(p);
        await dirtyTitle(p);
        await p.keyboard.press('ControlOrMeta+s');
      },
    },
    masks: STUDIO,
  },
  // ---- preview (§10.7) -----------------------------------------------------------------
  {
    name: 'studio-preview',
    proto: studio(OFFER, {}, { call: 'c.enterPreview()' }),
    build: { path: `/document-templates/${OFFER}`, mock: studioMock(), act: (p) => p.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Preview' }).click() },
    masks: [...STUDIO, PREVIEW_FOOT, LONG_VALUES],
  },
  {
    name: 'studio-preview-plain',
    proto: studio(OFFER, {}, { call: 'c.enterPreview().then(() => c.setState({ hl: false }))' }),
    build: {
      path: `/document-templates/${OFFER}`,
      mock: studioMock(),
      act: async (p) => {
        await p.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Preview' }).click();
        await p.getByLabel('Highlight variables').uncheck();
      },
    },
    masks: [...STUDIO, PREVIEW_FOOT, LONG_VALUES, PLAIN_BODY],
  },
  {
    name: 'studio-preview-zoom',
    proto: studio(OFFER, {}, { call: 'c.enterPreview().then(() => c.setState({ zoom: 110 }))' }),
    build: {
      path: `/document-templates/${OFFER}`,
      mock: studioMock(),
      act: async (p) => {
        await p.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Preview' }).click();
        await p.getByRole('button', { name: 'Zoom in' }).click();
      },
    },
    masks: [...STUDIO, PREVIEW_FOOT, LONG_VALUES],
  },
  // ---- publish, versions, compare, withdraw (§10.7–10.8) -------------------------------
  {
    name: 'studio-publish-dialog',
    blur: true,
    proto: studio(INTV, { previewedRev: 1 }, { call: 'c.renderVals().st.publish()' }),
    build: { path: `/document-templates/${INTV}`, mock: studioMock({ overrides: [detailOverride(INTV, previewedDraft)] }), act: (p) => p.getByRole('button', { name: 'Publish v1…' }).click() },
    masks: STUDIO,
  },
  {
    name: 'studio-version-view',
    proto: studio(OFFER, { leftTab: 'versions', mode: 'version', viewVer: 3, leftOpen: true }),
    build: {
      path: `/document-templates/${OFFER}`,
      mock: studioMock(),
      act: async (p) => {
        await tab(p, 'Versions');
        await p.getByRole('button', { name: /^v3/ }).first().click();
      },
    },
    masks: [...STUDIO, RO_DOC('section[aria-label="Document"] h1 + div')],
  },
  {
    name: 'studio-compare',
    blur: true,
    proto: studio(OFFER, {}, { call: 'c.renderVals().st.compare()' }),
    build: { path: `/document-templates/${OFFER}`, mock: studioMock(), act: (p) => p.getByRole('button', { name: 'Compare' }).click() },
    masks: STUDIO,
  },
  {
    name: 'studio-compare-changes',
    blur: true,
    proto: studio(OFFER, {}, { call: "c.renderVals().st.compare(); c.setState((s) => ({ cmp: { ...s.cmp, changesOnly: true } }))" }),
    build: {
      path: `/document-templates/${OFFER}`,
      mock: studioMock(),
      act: async (p) => {
        await p.getByRole('button', { name: 'Compare' }).click();
        // A dispatched click: check() would first scroll the (overflow-hidden) dialog.
        await p.getByLabel('Changes only').dispatchEvent('click');
      },
    },
    masks: STUDIO,
  },
  {
    name: 'studio-withdraw-dialog',
    blur: true,
    // AA-01 (DIVERGENCES.md): dialog title/label glyphs rasterise differently on
    // every run (116–134 px measured, no layout shift).
    aaAllowance: 160,
    proto: studio(NDA, {}, { call: 'c.renderVals().st.withdraw()' }),
    build: {
      path: `/document-templates/${NDA}`,
      mock: studioMock(),
      act: async (p) => {
        await more(p);
        await p.getByRole('menuitem', { name: 'Withdraw template…' }).click();
      },
    },
    masks: STUDIO,
  },
  {
    name: 'studio-withdrawal-pending',
    proto: studio(CONT),
    build: { path: `/document-templates/${CONT}`, mock: studioMock() },
    masks: [...STUDIO, WD_REASON],
  },
  // ---- view only, empty, shortcuts ----------------------------------------------------
  {
    name: 'studio-viewonly',
    proto: { ...studio(OFFER), studio: { persona: 'reader' } },
    build: { path: `/document-templates/${OFFER}`, mock: studioMock({ persona: 'auditor' }) },
    masks: [...STUDIO, ...READER_IDENTITY, ...READER_PANELS, LONG_VALUES, RO_DOC('article > div:nth-child(3)')],
  },
  {
    name: 'studio-empty',
    proto: studio(INTV, {}, { call: 'c.H = {}; c.upTp((x) => ({ ...x, blocks: [] }))' }),
    build: { path: `/document-templates/${INTV}`, mock: studioMock({ overrides: [detailOverride(INTV, emptyDraft)] }) },
    masks: STUDIO,
  },
  {
    name: 'studio-shortcuts',
    blur: true,
    proto: studio(OFFER, { shortcuts: true }),
    build: { path: `/document-templates/${OFFER}`, mock: studioMock(), act: (p) => p.keyboard.press('?') },
    masks: STUDIO,
  },
  // ---- below 1280 / 1100 (§10.2): the panels as overlays ------------------------------
  {
    name: 'studio-left-overlay',
    viewports: ['900'],
    proto: studio(OFFER, { leftOpen: true }),
    build: { path: `/document-templates/${OFFER}`, mock: studioMock(), act: (p) => toggle(p, 'Toggle outline') },
    masks: STUDIO,
  },
  {
    name: 'studio-right-overlay',
    viewports: ['900'],
    proto: studio(OFFER, { rightOpen: true }),
    build: { path: `/document-templates/${OFFER}`, mock: studioMock(), act: (p) => toggle(p, 'Toggle inspector') },
    masks: STUDIO,
  },
];
