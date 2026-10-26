// CCP-UI-V12 — the CCP-UI v1.2 screen-states: Finance › Renewals, Outstanding payments, Billing
// reconciliation, Revenue; Usage › Consumption; Operations › Alerts; the scope-aware access-denied
// card (AM-2), rendered from the pinned Commercial Control Plane v1.2.dc.html (release CCP-UI v1.2,
// manifest 5/5) and from the build on the v1.2 fixture dataset (e2e/fixtures/ccp-v12.ts) at
// 1440×900 and 900×900. Holder = Priya Shah (finance_admin, platform:billing:amount:read); non-holder
// = Tomás Silva (commercial_ops). Every mask is a sanctioned divergence in DIVERGENCES.md (DV-C1,
// DV-C2 from B1; DV-V12-*).

import type { Page } from '@playwright/test';

import { V12_CR, ccpMock as crMock } from '../fixtures/commercial';
import { V12_TENANTS, v12Mock, type V12Options } from '../fixtures/ccp-v12';
import type { CcpProtoProps } from '../support/proto-ccp';
import type { Persona } from '../fixtures/session';

import { swap } from './masks-common';
import type { Mask, ScreenState } from './state-types';

const SHELL: readonly Mask[] = [
  { proto: (p) => p.locator('nav[aria-label="Platform admin"]'), build: (p) => p.locator('.rc-rail'), divergence: 'DV-C1' },
  swap('DV-C2', 'Tenants, requests, pages', 'Tenants, skills, templates'),
];

type Route = 'renewals' | 'outstanding' | 'recon' | 'revenue' | 'usage' | 'alerts';
const PATH: Readonly<Record<Route, string>> = {
  renewals: '/commercial/finance/renewals',
  outstanding: '/commercial/finance/outstanding-payments',
  recon: '/commercial/finance/reconciliation',
  revenue: '/commercial/finance/revenue',
  usage: '/commercial/usage',
  alerts: '/commercial/alerts',
};

const PROTO_PERSONA: Readonly<Record<string, NonNullable<CcpProtoProps['persona']>>> = { ccpFinance: 'priya', ccpOps: 'tomas', ccpCatalog: 'lena', ccpSupport: 'kwame', ccpAuditor: 'ines', ccpOwner: 'daniel' };

function state(
  name: string,
  route: Route,
  persona: Persona,
  o: { readonly proto?: Partial<CcpProtoProps>; readonly mock?: V12Options; readonly masks?: readonly Mask[]; readonly act?: (p: Page) => Promise<void>; readonly protoState?: Record<string, unknown>; readonly aaAllowance?: number } = {},
): ScreenState {
  return {
    name,
    proto: { file: 'ccp', ccp: { release: 'v1_2', persona: PROTO_PERSONA[persona], startRoute: route, ...(o.proto ?? {}) }, hash: route, state: o.protoState },
    build: { path: PATH[route], mock: () => v12Mock(persona, o.mock ?? {}), act: o.act },
    masks: [...SHELL, ...(o.masks ?? [])],
    aaAllowance: o.aaAllowance,
  };
}


/** DV-V12-REV-1 (Lead correction): the list-price figures are never labelled MRR / ARR / revenue; the note is added. */
const REVENUE_COPY: readonly Mask[] = [
  { proto: (p) => p.locator('main h1 + p'), build: (p) => p.locator('main .pc-intro'), divergence: 'DV-V12-REV-1' },
  // The non-holder view-only note's wording ("Revenue figures" → "These figures").
  { proto: (p) => p.locator('main div').filter({ hasText: /^View only\. Revenue figures/ }).last(), build: (p) => p.locator('main .pf-note[role="note"]').filter({ hasText: /^View only\./ }), divergence: 'DV-V12-REV-1' },
  // DV-V12-9 / DV-V12-REV-1: the design's "Design only" banner (D2 is delivered) where the build shows the list-price note.
  { proto: (p) => p.locator('main div').filter({ hasText: /^Design only\./ }).last(), build: (p) => p.getByTestId('revenue-list-price-note'), divergence: 'DV-V12-REV-1' },
  { proto: (p) => p.locator('main div').filter({ hasText: /^(MRR|ARR)$/ }), build: (p) => p.locator('.pf-tile__label').filter({ hasText: /^Illustrative/ }), divergence: 'DV-V12-REV-1', padRight: 200 },
  { proto: (p) => p.locator('main div').filter({ hasText: /^MRR × 12$/ }), build: (p) => p.locator('.pf-tile__sub').filter({ hasText: /^Monthly value × 12$/ }), divergence: 'DV-V12-REV-1', padRight: 60 },
  // DV-V12-13: the Withheld tile names the exclusion reasons with counts (D2 carries no per-tenant row).
  { proto: (p) => p.locator('main div').filter({ hasText: /^Withheld$/ }).locator('xpath=following-sibling::div[2]'), build: (p) => p.locator('.pf-tile').filter({ hasText: /^Withheld/ }).locator('.pf-tile__sub'), divergence: 'DV-V12-13', padRight: 200 },
];

/**
 * DV-V12-REV-1 — the two-line value labels make the tile row taller, shifting everything below it;
 * the tiles row is masked to the bottom here and the renewals-by-month card is compared on its own
 * (element-level states `v12-revenue-months*`).
 */
const TILES_DOWN: Mask = { proto: (p) => p.locator('main div').filter({ has: p.locator('div', { hasText: /^MRR$/ }) }).filter({ has: p.locator('div', { hasText: /^Included$/ }) }).last(), build: (p) => p.locator('.pf-tiles'), divergence: 'DV-V12-REV-1', toBottom: true };
const PROTO_MONTHS = (p: Page) => p.locator('main section').filter({ has: p.locator('h2', { hasText: /^Renewals by month$/ }) });
const BUILD_MONTHS = (p: Page) => p.locator('section[aria-labelledby="pf-rv-months"]');

/** Data divergences: the first table of the page and everything below it (real DTO values: UUID references, the server's own detail text, no per-row reason). */
const TABLE_DOWN = (dv: string): Mask => ({ proto: (p) => p.locator('main table').first(), build: (p) => p.locator('main table').first(), divergence: dv, toBottom: true, padRight: 60 });

/** B1's DV-C6 — the in-shell card keeps R-5's Missing row and Sign out, and says Back to dashboard. */
const DENIED_TAIL: Mask = {
  proto: (p) => p.getByRole('link', { name: 'Sign in with a different account' }).locator('..'),
  build: (p) => p.locator('.pw-denied__facts dt').filter({ hasText: /^Missing$/ }),
  divergence: 'DV-C6',
  toBottom: true,
  padTop: 33,
  padLeft: 33,
  padRight: 33,
};

/** DV-V12-6: the run mode is not on the D1 reconciliation read (the banner line ends at the time). */
/** DV-V12-10 (R-18): the alerts footer's two banned words are reworded. */
const ALERTS_FOOT: Mask = { proto: (p) => p.locator('main div').filter({ hasText: /^Severity is operational only\./ }).last(), build: (p) => p.locator('.pf-foot'), divergence: 'DV-V12-10' };

const USAGE_BANNER: Mask = { proto: (p) => p.locator('main [role="status"], main [role="alert"]').first(), build: (p) => p.getByTestId('usage-recon-banner'), divergence: 'DV-V12-6', toBottom: true, padRight: 60 };
/** DV-V12-8 / DV-V12-11: no route lists the roll-up runs (no Roll-up runs card); the refused card names the real 409 code. */
const USAGE_REFUSED: Mask = { proto: (p) => p.locator('main section').filter({ hasText: 'Usage analytics unavailable' }), build: (p) => p.getByTestId('usage-refused'), divergence: 'DV-V12-11', toBottom: true };
/** DV-V12-12: the segmented counts are the server register's (the design counts its in-memory sample). */
const ALERT_COUNTS: Mask = { proto: (p) => p.locator('main [role="group"] button span'), build: (p) => p.locator('.pf-seg__count'), divergence: 'DV-V12-12', padRight: 6 };
/** DV-V12-15: the Exceptions tile is the server's `counts.exceptions` (stuck commands are listed, not counted). */
const EXC_TILE: Mask = { proto: (p) => p.locator('main div').filter({ hasText: /^Exceptions$/ }).locator('xpath=following-sibling::div[1]'), build: (p) => p.locator('.pw-exctile__n'), divergence: 'DV-V12-15' };

/** DV-V12-REV-1 — the Renewals intro points to list-price values, not "revenue figures". */
const RENEWALS_INTRO: Mask = { proto: (p) => p.locator('main h1 + p'), build: (p) => p.locator('main .pc-intro'), divergence: 'DV-V12-REV-1' };

export const CCP_V12_STATES: readonly ScreenState[] = [
  // ── Finance › Renewals (§13.1) ──
  // AA-V12-1: 80 px of 1-px glyph edges in the Plan · version, End date and List price columns at
  // 1440 (sub-pixel column offsets of the auto table layout), on every run; no layout difference.
  state('v12-renewals', 'renewals', 'ccpFinance', { masks: [RENEWALS_INTRO], aaAllowance: 100 }),
  // W-1 also changes the auto table layout (a price is wider than the Withheld chip): the table is masked.
  state('v12-renewals-nonholder', 'renewals', 'ccpOps', { masks: [RENEWALS_INTRO, { ...TABLE_DOWN('DV-V12-W1') }] }),
  state('v12-renewals-empty', 'renewals', 'ccpFinance', { proto: { demoState: 'empty' }, mock: { empty: true }, masks: [RENEWALS_INTRO] }),
  state('v12-renewals-loading', 'renewals', 'ccpFinance', { proto: { demoState: 'loading' }, mock: { loading: true }, masks: [RENEWALS_INTRO] }),
  // ── Finance › Outstanding payments (§13.2; §17.2) ──
  state('v12-outstanding', 'outstanding', 'ccpFinance', { masks: [TABLE_DOWN('DV-V12-T')] }),
  state('v12-outstanding-nonholder', 'outstanding', 'ccpOps', { masks: [TABLE_DOWN('DV-V12-T')] }),
  state('v12-outstanding-empty', 'outstanding', 'ccpFinance', { proto: { demoState: 'empty' }, mock: { empty: true } }),
  // ── Finance › Billing reconciliation (§13.3) ──
  state('v12-recon', 'recon', 'ccpFinance', { masks: [EXC_TILE, TABLE_DOWN('DV-V12-T')] }),
  state('v12-recon-nonholder', 'recon', 'ccpOps', { masks: [EXC_TILE, TABLE_DOWN('DV-V12-T')] }),
  state('v12-recon-empty', 'recon', 'ccpFinance', { proto: { demoState: 'empty' }, mock: { empty: true }, masks: [EXC_TILE] }),
  // ── Finance › Revenue (§13.5; §17.2) ──
  state('v12-revenue', 'revenue', 'ccpFinance', { masks: [...REVENUE_COPY, TILES_DOWN] }),
  state('v12-revenue-nonholder', 'revenue', 'ccpOps', { masks: [...REVENUE_COPY, TILES_DOWN] }),
  { ...state('v12-revenue-months', 'revenue', 'ccpFinance'), masks: [], element: { proto: PROTO_MONTHS, build: BUILD_MONTHS } },
  { ...state('v12-revenue-months-nonholder', 'revenue', 'ccpOps'), masks: [], element: { proto: PROTO_MONTHS, build: BUILD_MONTHS } },
  state('v12-revenue-empty', 'revenue', 'ccpFinance', { proto: { demoState: 'empty' }, mock: { empty: true }, masks: REVENUE_COPY }),
  // ── Usage › Consumption (§13.4) ──
  state('v12-usage', 'usage', 'ccpFinance', { masks: [USAGE_BANNER, TABLE_DOWN('DV-V12-T')] }),
  state('v12-usage-pending', 'usage', 'ccpFinance', { proto: { usageRecon: 'pending' }, mock: { usage: 'pending' }, masks: [USAGE_BANNER, TABLE_DOWN('DV-V12-T')] }),
  state('v12-usage-refused', 'usage', 'ccpFinance', { proto: { usageRecon: 'notReconciled' }, mock: { usage: 'notReconciled' }, masks: [USAGE_BANNER, USAGE_REFUSED] }),
  // ── Operations › Alerts (§13.6) ──
  // AA-V12-2: 27 px of glyph edges in the segmented filter at 1440 (the count spans are masked).
  state('v12-alerts', 'alerts', 'ccpFinance', { masks: [ALERT_COUNTS, TABLE_DOWN('DV-V12-T')], aaAllowance: 40 }),
  state('v12-alerts-resolved', 'alerts', 'ccpFinance', { proto: { keepPilotV0: true }, protoState: { alF: 'resolved' }, act: async (p) => p.getByRole('button', { name: /^Resolved/ }).click(), masks: [ALERT_COUNTS, TABLE_DOWN('DV-V12-T')], aaAllowance: 40 }),
  state('v12-alerts-empty', 'alerts', 'ccpFinance', { proto: { demoState: 'empty' }, mock: { empty: true }, masks: [ALERTS_FOOT] }),
  // ── AM-2: the scope-gated access-denied card (catalog_manager on a Finance page) ──
  state('v12-denied-renewals', 'renewals', 'ccpCatalog', { masks: [DENIED_TAIL] }),

  // ── AM-3 / AM-5 / AM-6 (v1.2 D-1, D-4): the change-request drawer, element-level (the stepper and
  // the footer; the facts and the effect carry B1's data divergences DV-C3…DV-C5) ──
  {
    name: 'v12-drawer-stepper-approved',
    proto: { file: 'ccp', ccp: { release: 'v1_2', persona: 'tomas', keepPilotV0: true }, hash: 'approvals', state: { crOpen: 'CR-1054' } },
    build: { path: `/commercial/approvals?request=${V12_CR.c1054}`, mock: () => crMock({ persona: 'ccpOps', v12: true })() },
    element: { proto: (p) => p.locator('aside[role="dialog"] ol[aria-label="Request state"]'), build: (p) => p.getByTestId('cr-drawer').locator('ol[aria-label="Request state"]') },
    blur: true,
  },
  {
    name: 'v12-drawer-stepper-apply-expired',
    proto: { file: 'ccp', ccp: { release: 'v1_2', persona: 'tomas', keepPilotV0: true }, hash: 'approvals', state: { crOpen: 'CR-1055' } },
    build: { path: `/commercial/approvals?request=${V12_CR.c1055}`, mock: () => crMock({ persona: 'ccpOps', v12: true })() },
    element: { proto: (p) => p.locator('aside[role="dialog"] ol[aria-label="Request state"]'), build: (p) => p.getByTestId('cr-drawer').locator('ol[aria-label="Request state"]') },
    blur: true,
  },
  {
    // AM-6: the requester's Apply (requester-only, `apply_actionable`).
    name: 'v12-drawer-footer-apply',
    proto: { file: 'ccp', ccp: { release: 'v1_2', persona: 'tomas', keepPilotV0: true }, hash: 'approvals', state: { crOpen: 'CR-1054' } },
    build: { path: `/commercial/approvals?request=${V12_CR.c1054}`, mock: () => crMock({ persona: 'ccpOps', v12: true })() },
    element: { proto: (p) => p.locator('aside[role="dialog"] > div').last(), build: (p) => p.locator('.tc-dialog__content:has(.pw-drawer--ccp) .tc-dialog__footer') },
    blur: true,
  },
  {
    // AM-6 + D-4: the requester of a failed policy activation: Retry apply and Withdraw….
    name: 'v12-drawer-footer-failed-policy',
    proto: { file: 'ccp', ccp: { release: 'v1_2', persona: 'priya' }, hash: 'approvals', state: { crOpen: 'CR-1053' } },
    build: { path: `/commercial/approvals?request=${V12_CR.c1053}`, mock: () => crMock({ persona: 'ccpFinance', v12: true })() },
    element: { proto: (p) => p.locator('aside[role="dialog"] > div').last(), build: (p) => p.locator('.tc-dialog__content:has(.pw-drawer--ccp) .tc-dialog__footer') },
    blur: true,
  },
  {
    // D-4: the withdraw dialog. DV-V12-6: no Reason field (the withdraw route takes no body), so the
    // dialog is shorter; its Before → after box is compared element-level (title, consequence, the
    // two inline refusals and the disabled commit are asserted by finance-components.spec and
    // ccp-v12-drawer.spec).
    name: 'v12-withdraw-dialog',
    proto: { file: 'ccp', ccp: { release: 'v1_2', persona: 'priya' }, hash: 'approvals', state: { crOpen: 'CR-1053' }, call: "c.dlgWithdrawFailed(c.state.crs.find(x => x.id === 'CR-1053'))" },
    build: {
      path: `/commercial/approvals?request=${V12_CR.c1053}`,
      mock: () => crMock({ persona: 'ccpFinance', v12: true })(),
      act: async (p) => {
        await p.getByRole('button', { name: 'Withdraw…' }).click();
        await p.locator('.tc-dialog__content:has(.pw-crd)').waitFor();
      },
    },
    // The Before → after box (Request state: Apply failed → Withdrawn).
    element: {
      proto: (p) => p.locator('div[role="dialog"][aria-modal="true"] div').filter({ hasText: /^~?\s*Request state/ }).last().locator('..'),
      build: (p) => p.locator('.tc-dialog__content:has(.pw-crd) .pw-crd__diff'),
    },
    blur: true,
  },
  // ── AM-9 + v1.2 §17.2: Tenant › Commercial, Fernhill (past due in grace → Payment: Due) ──
  ...(['ccpFinance', 'ccpOps'] as const).map(
    (persona): ScreenState => ({
      name: persona === 'ccpFinance' ? 'v12-tc-payment-holder' : 'v12-tc-payment-nonholder',
      proto: { file: 'ccp', ccp: { release: 'v1_2', persona: PROTO_PERSONA[persona] }, hash: 'tenant/t_fernhill' },
      build: { path: `/tenants/${V12_TENANTS.fernhill}?tab=commercial`, mock: () => v12Mock(persona) },
      // The Sign card's facts grid (Plan … Tax, Payment, Amount due).
      element: { proto: (p) => p.locator('main section').filter({ has: p.locator('h2', { hasText: /^Aramo Sign$/ }) }).first().locator('div[style*="minmax(160px"]').first(), build: (p) => p.locator('section[data-product="sign"] .sx-facts') },
      masks: [
        // DV-B3-1 (B3): the Plan fact reads the real plan name, without "(SAMPLE)".
        { proto: (p) => p.locator('main div').filter({ hasText: /^Plan$/ }).locator('xpath=following-sibling::div[1]').first(), build: (p) => p.locator('section[data-product="sign"] .sx-facts__k').filter({ hasText: /^Plan$/ }).locator('xpath=following-sibling::div[1]'), divergence: 'DV-B3-1', padRight: 70 },
      ],
    }),
  ),
];