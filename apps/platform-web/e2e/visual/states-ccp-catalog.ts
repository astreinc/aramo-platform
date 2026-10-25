// CCP-B2 — the Catalog screen-states (CCP handoff §5.4) against the pinned CCP-UI v1.0 design
// file (Commercial Control Plane v1.0.dc.html), at 1440×900 and 900×900. Every mask is a typed,
// sanctioned divergence in DIVERGENCES.md (DV-B2-01…DV-B2-04).

import type { Page } from '@playwright/test';

import { swap } from './masks-common';
import type { Mask, ScreenState } from './state-types';

/** DV-B2-01 — the shell regions CCP-B1 owns (built in parallel): the rail with its Commercial
 * group, the breadcrumb "Commercial / Catalog" (from the B1 nav item) and the environment bar's
 * CCP context line. B2 does not edit the shell; the lead removes these three masks at the
 * B1 + B2 merge and re-captures the parity run. */
const PENDING_B1: readonly Mask[] = [
  { proto: (p) => p.locator('nav[aria-label="Platform admin"]'), build: (p) => p.locator('.rc-rail'), divergence: 'DV-B2-01' },
  { proto: (p) => p.getByRole('navigation', { name: 'Breadcrumb' }), build: (p) => p.getByRole('navigation', { name: 'Breadcrumb' }), divergence: 'DV-B2-01', padRight: 120 },
  { proto: (p) => p.locator('[role="banner"] > span:nth-child(2)'), build: (p) => p.locator('.pw-envbar__context'), divergence: 'DV-B2-01', textBox: true, padRight: 40 },
  // At 900px the CCP context line is long enough to truncate the identity text differently.
  { proto: (p) => p.locator('[role="banner"] > span:nth-child(4)'), build: (p) => p.getByTestId('envbar-identity'), divergence: 'DV-B2-01', viewport: '900' },
  // ⌘K: the CCP file searches "Tenants, requests, pages" (request results, handoff §5.11 → B1).
  { proto: (p) => p.getByText('Tenants, requests, pages', { exact: true }), build: (p) => p.getByText('Tenants, skills, templates', { exact: true }), divergence: 'DV-B2-01', textBox: true, padRight: 16 },
];

/** DV-B2-02 — the prototype's "SAMPLE" markers on its mock prices: the build shows real catalog
 * data, which is not sample data. */
const SAMPLE: readonly Mask[] = [
  // The build renders no tag: the region exists in the reference only.
  { proto: (p) => p.getByText('SAMPLE NAMES AND PRICES', { exact: true }), build: (p) => p.locator('[data-ccp-sample-tag]'), divergence: 'DV-B2-02', padRight: 4 },
  swap('DV-B2-02', '5 plans · SAMPLE', '5 plans'),
];

/** DV-B2-03 — Seats: the Sign plan model stores no seat limit (R-13): the build shows the
 * designed disabled field with no value, and "—" in the diff row. */
const SEATS: readonly Mask[] = [
  { proto: (p) => p.locator('label').filter({ hasText: /^Seats$/ }).locator('input'), build: (p) => p.getByLabel('Seats', { exact: true }), divergence: 'DV-B2-03' },
];
const SEATS_DIFF: Mask = {
  // The diff row is the last (deepest) div holding a "Seats" cell.
  proto: (p) => p.locator('main div').filter({ has: p.getByText('Seats', { exact: true }) }).last(),
  build: (p) => p.locator('.pc-diff__row').filter({ hasText: 'Seats' }),
  divergence: 'DV-B2-03',
};
const SEATS_DIALOG_DIFF: Mask = {
  proto: (p) => p.getByRole('dialog').locator('div').filter({ has: p.getByText(/^~?\s*Seats$/) }).last(),
  build: (p) => p.locator('.pw-crd__diff-row').filter({ hasText: 'Seats' }),
  divergence: 'DV-B2-03',
};

/** DV-B2-04 — a change request is a UUID: the open-request line shows its short id where the
 * prototype shows "CR-1044". */
const CR_ID: Mask = {
  // The id's width moves the rest of the line, so the line's text is masked (the box is not).
  proto: (p) => p.locator('div').filter({ has: p.getByText('CR-1044', { exact: true }) }).last(),
  build: (p) => p.getByTestId('open-request'),
  divergence: 'DV-B2-04',
  textBox: true,
  padRight: 40,
};

const CAT = '/commercial/catalog';
const at = (q: string) => `${CAT}?${q}`;

export const CCP_CATALOG_STATES: readonly ScreenState[] = [
  {
    name: 'ccp-catalog-draft',
    proto: { file: 'ccp', hash: 'catalog', ccp: { persona: 'lena' } },
    build: { path: at('plan=team&version=3'), mock: { persona: 'ccpCatalog' } },
    masks: [...PENDING_B1, ...SAMPLE, ...SEATS, SEATS_DIFF, CR_ID],
  },
  {
    name: 'ccp-catalog-viewonly',
    proto: { file: 'ccp', hash: 'catalog', ccp: { persona: 'daniel' } },
    build: { path: at('plan=team&version=3'), mock: { persona: 'ccpOwner' } },
    masks: [...PENDING_B1, ...SAMPLE, ...SEATS, SEATS_DIFF, CR_ID],
  },
  {
    name: 'ccp-catalog-published',
    proto: { file: 'ccp', hash: 'catalog', ccp: { persona: 'lena' }, state: { cat: { prod: 'sign', plan: 'team', ver: 2 } } },
    build: { path: at('plan=team&version=2'), mock: { persona: 'ccpCatalog' } },
    masks: [...PENDING_B1, ...SAMPLE, ...SEATS],
  },
  {
    name: 'ccp-catalog-retired',
    proto: { file: 'ccp', hash: 'catalog', ccp: { persona: 'lena' }, state: { cat: { prod: 'sign', plan: 'business', ver: 1 } } },
    build: { path: at('plan=business&version=1'), mock: { persona: 'ccpCatalog' } },
    masks: [...PENDING_B1, ...SAMPLE, ...SEATS],
  },
  {
    name: 'ccp-catalog-no-plans',
    proto: { file: 'ccp', hash: 'catalog', ccp: { persona: 'lena' }, state: { cat: { prod: 'ats', plan: 'team', ver: 3 } } },
    build: { path: at('product=ats'), mock: { persona: 'ccpCatalog' } },
    masks: [...PENDING_B1, SAMPLE[1] as Mask],
  },
  {
    name: 'ccp-catalog-publish-dialog',
    blur: true,
    // AA-B2-01: the dialog's text rasterises differently on every run (glyph edges only).
    aaAllowance: 300,
    proto: {
      file: 'ccp',
      hash: 'catalog',
      ccp: { persona: 'lena' },
      call: `const pl = c.plan('team'); const p2 = Object.assign({}, pl, { vers: pl.vers.map(v => v.v === 3 ? Object.assign({}, v, { cr: null }) : v) }); c.setState(s => ({ plans: s.plans.map(x => x.id === 'team' ? p2 : x) })); c.dlgCatalog('publish', p2, p2.vers.find(v => v.v === 3));`,
    },
    build: { path: at('plan=team&version=3'), mock: { persona: 'ccpCatalog', catalog: { noOpenRequest: true } }, act: (p: Page) => p.getByRole('button', { name: 'Request publish…' }).click() },
    masks: [...PENDING_B1, ...SAMPLE, ...SEATS, SEATS_DIFF, SEATS_DIALOG_DIFF],
  },
  {
    name: 'ccp-catalog-retire-dialog',
    blur: true,
    // AA-B2-01.
    aaAllowance: 300,
    proto: {
      file: 'ccp',
      hash: 'catalog',
      ccp: { persona: 'lena' },
      state: { cat: { prod: 'sign', plan: 'team', ver: 2 } },
      call: `const pl = c.plan('team'); c.dlgCatalog('retire', pl, pl.vers.find(v => v.v === 2));`,
    },
    build: { path: at('plan=team&version=2'), mock: { persona: 'ccpCatalog' }, act: (p: Page) => p.getByRole('button', { name: 'Request retire…' }).click() },
    masks: [...PENDING_B1, ...SAMPLE, ...SEATS],
  },
];
