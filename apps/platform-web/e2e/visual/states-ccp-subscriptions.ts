// CCP-B3 — the Subscriptions workbench and Tenant › Commercial screen-states (CCP-UI v1.0 handoff
// §5.3, §5.9, §5.10), rendered from the pinned Commercial Control Plane v1.0.dc.html (reference)
// and from the build on the B3 fixture dataset (e2e/fixtures/ccp-subscriptions.ts) at 1440×900
// and 900×900. The workbench states compare the full frame with B1's shell masks (DV-C1, DV-C2);
// the tab states compare ONE element (a product card, the view-only note, a dialog box), because
// the tenant page header and tab strip are PLATFORM-UX-1's (different tab labels, no NEW tag).
// Every mask is a sanctioned divergence in DIVERGENCES.md (DV-C1, DV-C2, DV-B3-*).

import type { Page } from '@playwright/test';

import { subsMock, tenantPath } from '../fixtures/ccp-subscriptions';
import { swap } from './masks-common';
import type { Mask, ScreenState } from './state-types';

const SHELL: readonly Mask[] = [
  { proto: (p) => p.locator('nav[aria-label="Platform admin"]'), build: (p) => p.locator('.rc-rail'), divergence: 'DV-C1' },
  swap('DV-C2', 'Tenants, requests, pages', 'Tenants, skills, templates'),
];

/**
 * DV-B3-1 — the table: the build shows real catalog plan names without the prototype's "SAMPLE"
 * tag, and the auto table layout sizes every column (head included) from the cells, so every
 * column moves; masked whole. The row content is asserted by SubscriptionsView.spec.tsx.
 */
const TABLE: Mask = { proto: (p) => p.locator('main table'), build: (p) => p.locator('main table'), divergence: 'DV-B3-1', toBottom: true };

/** DV-B3-9 — while the read is in flight the build shows no counts (it has no rows yet); the design counts its in-memory rows. */
const LOADING_COUNTS: readonly Mask[] = [
  { proto: (p) => p.locator('[role="group"][aria-label="Status"] button span'), build: (p) => p.locator('.cs-seg__count'), divergence: 'DV-B3-9', padRight: 6 },
  { proto: (p) => p.locator('main span').filter({ hasText: /^\d+ of \d+$/ }), build: (p) => p.getByTestId('subscriptions-count'), divergence: 'DV-B3-9', padLeft: 30 },
];

const SUBS = '/commercial/subscriptions';

// ── Tenant › Commercial elements ──
const protoCard = (name: string) => (p: Page) => p.locator('main section').filter({ has: p.locator('h2', { hasText: new RegExp(`^${name}$`) }) }).first();
const buildCard = (key: string) => (p: Page) => p.locator(`section[data-product="${key}"]`);
const PROTO_DIALOG = (p: Page) => p.locator('div[role="dialog"][aria-modal="true"]');
const BUILD_DIALOG = (p: Page) => p.locator('.tc-dialog__content:has(.pw-crd)');

/** DV-B3-1 — the Plan fact: "Sign Scale (SAMPLE)" vs the real plan name. */
const PLAN_FACT = (name: string, key: string): Mask => ({
  proto: (p) => protoCard(name)(p).locator('div').filter({ hasText: /^Plan$/ }).locator('xpath=following-sibling::div[1]'),
  build: (p) => buildCard(key)(p).locator('.sx-facts__k').filter({ hasText: /^Plan$/ }).locator('xpath=following-sibling::div[1]'),
  divergence: 'DV-B3-1',
  padRight: 70,
});

/** DV-B3-2 — a change request is a UUID: "CR-1A2B3C4D" where the prototype shows "CR-1051"; the open-request line also names the real action type ("Subscription conversion"). */
const OPEN_STRIP: Mask = { proto: (p) => protoCard('Aramo Sign')(p).locator('div').filter({ hasText: /^Open request / }).last(), build: (p) => p.getByTestId('open-request'), divergence: 'DV-B3-2' };
const RECON_REF: Mask = { proto: (p) => protoCard('Aramo Sign')(p).locator('[role="alert"] a'), build: (p) => p.locator('.cs-recon__ref'), divergence: 'DV-B3-2', padRight: 30 };

/** DV-B3-3 — the held-activation detail names no plan (the hold record carries the provider subscription, not the plan): the alert's text block. */
const RECON_TEXT: Mask = { proto: (p) => protoCard('Aramo Sign')(p).locator('[role="alert"]'), build: (p) => p.getByTestId('held-activation'), divergence: 'DV-B3-3' };

/** DV-B3-4 — the Stripe-owned card: the link-outs (TD-C3-1: only an invoice link exists, C3 NOT DELIVERED) and the extra governed conversion action. */
const STRIPE_LINKS: Mask = { proto: (p) => protoCard('Aramo Sign')(p).locator('a').filter({ hasText: /↗$/ }).first().locator('..'), build: (p) => p.locator('.cs-self__links'), divergence: 'DV-B3-4', padRight: 40 };
const ACTIONS_DOWN = (name: string, key: string, dv: string): Mask => ({
  proto: (p) => protoCard(name)(p).locator('button').first().locator('..'),
  build: (p) => buildCard(key)(p).locator('.sx-actions'),
  divergence: dv,
  toBottom: true,
});

/** DV-B3-7 — an ended row has no sending account, so its allowance bar shows the designed empty state ("No current allowance period", empty track). */
const ENDED_ALLOWANCE: Mask = {
  proto: (p) => protoCard('Aramo Sign')(p).locator('span').filter({ hasText: /envelopes$/ }),
  build: (p) => buildCard('sign')(p).locator('.cs-allow__value'),
  divergence: 'DV-B3-7',
  padLeft: 80,
};
const ENDED_TRACK: Mask = {
  proto: (p) => protoCard('Aramo Sign')(p).locator('span').filter({ hasText: /envelopes$/ }).locator('xpath=../following-sibling::div[1]'),
  build: (p) => buildCard('sign')(p).locator('.cs-allow__track'),
  divergence: 'DV-B3-7',
};

/** DV-B3-2 — the revoke provenance names the request by its UUID reference. */
const PROV_REF = (name: string, key: string): Mask => ({
  proto: (p) => protoCard(name)(p).locator('> div').first().locator('> span').last(),
  build: (p) => buildCard(key)(p).locator('.cs-prov'),
  divergence: 'DV-B3-2',
  // "CR-1A2B3C4D" is wider than "CR-1032" (right-aligned): cover the longer reference; the
  // build's span rounds to the neighbouring pixel row.
  padLeft: 60,
  padTop: 2,
  padBottom: 2,
});

const opsMock = (o?: Parameters<typeof subsMock>[1]) => subsMock('ccpOps', o);
const click = (label: string) => async (p: Page) => {
  await p.getByRole('button', { name: label }).first().click();
  await BUILD_DIALOG(p).waitFor();
};

/** DV-B3-1 — the plan select's option text carries no "(SAMPLE)". */
const PLAN_SELECT: Mask = { proto: (p) => PROTO_DIALOG(p).locator('select'), build: (p) => BUILD_DIALOG(p).locator('select'), divergence: 'DV-B3-1' };
/** DV-B3-5 — the discount: the designed disabled field and its help line (a plan change carries no discount term). */
const DISCOUNT: Mask = { proto: (p) => PROTO_DIALOG(p).locator('input[type="number"]').locator('..'), build: (p) => BUILD_DIALOG(p).getByLabel('Discount (%)').locator('..'), divergence: 'DV-B3-5' };
/** DV-B3-6 — cancel: the consequence line and the entitlement row (a cancel does not revoke, TD-A6-8) and the chain (TD-A3-2 Finance-only). */
const CANCEL_SUB: Mask = { proto: (p) => PROTO_DIALOG(p).locator('h2 + p'), build: (p) => BUILD_DIALOG(p).locator('.tc-dialog__description'), divergence: 'DV-B3-6', padLeft: 22, padRight: 22, padTop: 6, padBottom: 12 };
const DIFF_ROW = (field: RegExp, dv: string): Mask => ({
  proto: (p) => PROTO_DIALOG(p).locator('div').filter({ has: p.getByText(field) }).last(),
  build: (p) => BUILD_DIALOG(p).locator('.pw-crd__diff-row').filter({ hasText: field }),
  divergence: dv,
});
const CHAIN: Mask = { proto: (p) => PROTO_DIALOG(p).locator('div').filter({ has: p.getByText('Approval chain', { exact: true }) }).last(), build: (p) => BUILD_DIALOG(p).locator('.pw-chain'), divergence: 'DV-B3-6' };

export const CCP_SUBSCRIPTION_STATES: readonly ScreenState[] = [
  {
    name: 'ccp-subs-workbench',
    proto: { file: 'ccp', ccp: { startRoute: 'subs' }, hash: 'subs' },
    build: { path: SUBS, mock: subsMock('ccpOwner') },
    masks: [...SHELL, TABLE],
  },
  {
    name: 'ccp-subs-loading',
    proto: { file: 'ccp', ccp: { startRoute: 'subs', demoState: 'loading' }, hash: 'subs' },
    build: { path: SUBS, mock: subsMock('ccpOwner', { loading: true }) },
    masks: [...SHELL, ...LOADING_COUNTS],
  },
  {
    name: 'ccp-subs-empty',
    proto: { file: 'ccp', ccp: { startRoute: 'subs', demoState: 'empty' }, hash: 'subs' },
    build: { path: SUBS, mock: subsMock('ccpOwner', { empty: true }) },
    masks: [...SHELL],
  },
  {
    // Meridian: the governed MANUAL row, the held activation with its release in Stripe (C-8).
    name: 'ccp-tc-sign-held',
    proto: { file: 'ccp', ccp: { persona: 'tomas' }, hash: 'tenant/t_meridian' },
    build: { path: tenantPath('meridian'), mock: opsMock() },
    element: { proto: protoCard('Aramo Sign'), build: buildCard('sign') },
    masks: [PLAN_FACT('Aramo Sign', 'sign'), RECON_TEXT, RECON_REF, OPEN_STRIP],
  },
  {
    // Northwind: a Stripe-owned row, read-only (Managed in Stripe).
    name: 'ccp-tc-sign-stripe',
    proto: { file: 'ccp', ccp: { persona: 'tomas' }, hash: 'tenant/t_northwind' },
    build: { path: tenantPath('northwind'), mock: opsMock() },
    element: { proto: protoCard('Aramo Sign'), build: buildCard('sign') },
    masks: [PLAN_FACT('Aramo Sign', 'sign'), STRIPE_LINKS, OPEN_STRIP, ACTIONS_DOWN('Aramo Sign', 'sign', 'DV-B3-4')],
  },
  {
    // Brightline: an ended MANUAL row on a retired (grandfathered) version.
    name: 'ccp-tc-sign-ended',
    proto: { file: 'ccp', ccp: { persona: 'tomas' }, hash: 'tenant/t_brightline' },
    build: { path: tenantPath('brightline'), mock: opsMock() },
    element: { proto: protoCard('Aramo Sign'), build: buildCard('sign') },
    masks: [PLAN_FACT('Aramo Sign', 'sign'), ENDED_ALLOWANCE, ENDED_TRACK],
  },
  {
    // Brightline: Portal revoked (provenance), a product without plans.
    name: 'ccp-tc-portal-revoked',
    proto: { file: 'ccp', ccp: { persona: 'tomas' }, hash: 'tenant/t_brightline' },
    build: { path: tenantPath('brightline'), mock: opsMock() },
    // The card HEADER (DV-B3-8: the body lists one more domain reason, Grant has no governed path for Portal).
    element: { proto: (p) => protoCard('Portal')(p).locator('> div').first(), build: (p) => buildCard('portal')(p).locator('.sx-card__head') },
    masks: [PROV_REF('Portal', 'portal')],
    // AA-B3-2: the element-relative mask is re-anchored on the build header, whose box sits on a
    // different sub-pixel row than the design's; the mask's top and bottom edge rows (2 × 402 px at
    // 1440, 2 × 202 px at 900) differ, nothing else (diff image checked).
    aaAllowance: 810,
  },
  {
    // A Finance admin on the tenant: the view-only note, verbatim (§2; .dc.html td.viewOnlyText).
    name: 'ccp-tc-viewonly',
    proto: { file: 'ccp', ccp: { persona: 'priya' }, hash: 'tenant/t_atlas' },
    build: { path: tenantPath('atlas'), mock: subsMock('ccpFinance') },
    element: {
      proto: (p) => p.locator('main div').filter({ hasText: /^View only\. You can view this tenant’s commercial state\./ }).last(),
      build: (p) => p.locator('.cs-viewonly'),
    },
  },
  {
    name: 'ccp-tc-dialog-plan',
    proto: { file: 'ccp', ccp: { persona: 'tomas' }, hash: 'tenant/t_atlas', call: "c.dlgPlan(c.state.tenants.find(t => t.id === 't_atlas'), 'sign')" },
    build: { path: tenantPath('atlas'), mock: opsMock(), act: click('Request plan change…') },
    element: { proto: PROTO_DIALOG, build: BUILD_DIALOG },
    masks: [PLAN_SELECT, DISCOUNT],
    blur: true,
  },
  {
    name: 'ccp-tc-dialog-cancel',
    proto: { file: 'ccp', ccp: { persona: 'tomas' }, hash: 'tenant/t_atlas', call: "c.dlgSimple('CANCEL', c.state.tenants.find(t => t.id === 't_atlas'), 'sign')" },
    build: { path: tenantPath('atlas'), mock: opsMock(), act: click('Request cancel…') },
    element: { proto: PROTO_DIALOG, build: BUILD_DIALOG },
    masks: [CANCEL_SUB, DIFF_ROW(/Aramo Sign entitlement/, 'DV-B3-6'), CHAIN],
    blur: true,
  },
  {
    name: 'ccp-tc-dialog-revoke',
    proto: { file: 'ccp', ccp: { persona: 'tomas' }, hash: 'tenant/t_atlas', call: "c.dlgSimple('REVOKE', c.state.tenants.find(t => t.id === 't_atlas'), 'sign')" },
    build: { path: tenantPath('atlas'), mock: opsMock(), act: click('Revoke product…') },
    element: { proto: PROTO_DIALOG, build: BUILD_DIALOG },
    blur: true,
  },
  {
    name: 'ccp-tc-dialog-recon',
    proto: { file: 'ccp', ccp: { persona: 'tomas' }, hash: 'tenant/t_meridian', call: "c.dlgSimple('RECON', c.state.tenants.find(t => t.id === 't_meridian'), 'sign')" },
    build: { path: tenantPath('meridian'), mock: opsMock({ noRelease: true }), act: click('Request reconciliation release…') },
    element: { proto: PROTO_DIALOG, build: BUILD_DIALOG },
    masks: [DIFF_ROW(/Self-service checkout subscription/, 'DV-B3-3')],
    blur: true,
    // AA-B3-1: the dialog's rounded-corner edge rows blend the page behind it (the tenant page's
    // PLATFORM-UX-1 header and tab strip, not compared); measured 131 / 79 px, no box differs.
    aaAllowance: 140,
  },
];
