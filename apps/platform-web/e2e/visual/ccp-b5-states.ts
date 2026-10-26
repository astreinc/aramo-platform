// CCP-B5 — the screen-states of the governance screens (handoff §5.6 Policy, §5.7 Audit,
// §5.8 Platform admins › commercial roles), each rendered from the CCP design file
// (reference) and from the build (actual) at 1440×900 and 900×900.
//
// Comparison region (DIVERGENCES.md DV-B5-01): the slice-owned CONTENT — the area right of
// the rail and below the top bar (`content`), or the dialog itself (`dialog`). The rail,
// environment bar, top bar and bootstrap banner are CCP-B1's (parallel slice) and are covered
// by B1's parity record. Masks are only the typed divergences listed in DIVERGENCES.md.

import type { Locator, Page } from '@playwright/test';

import type { CcpMockOptions } from '../fixtures/ccp-governance';
import type { CcpProtoProps } from '../support/proto-ccp';

import type { ViewportSpec } from './state-types';

export interface CcpMask {
  readonly proto: (p: Page) => Locator;
  readonly build: (p: Page) => Locator;
  readonly divergence: string;
  readonly toBottom?: boolean;
  readonly textBox?: boolean;
  readonly padRight?: number;
}

export interface CcpState {
  readonly name: string;
  readonly clip: 'content' | 'dialog';
  readonly proto: { readonly props: CcpProtoProps; readonly call?: string };
  readonly build: { readonly path: string; readonly mock: CcpMockOptions; readonly act?: (p: Page) => Promise<void> };
  readonly masks?: readonly CcpMask[];
  readonly blur?: boolean;
  /**
   * Max differing pixels for this state only (default 25, the suite's AA bound). Dialog
   * clips: the rounded corners blend with the page behind the dialog, which is CCP-B1's
   * chrome (DIVERGENCES.md DV-B5-01).
   */
  readonly aaAllowance?: number;
  readonly viewports?: readonly ViewportSpec['name'][];
}

// DV-B5-02 — the policy table's two threshold help lines follow the PO boundary ruling A2-B
// ("at or above escalates"), not the design's "above … at or below".
const THRESHOLD_HELP: CcpMask[] = [
  { proto: (p) => p.getByText(/^Discounts above this need Finance/).locator('xpath=ancestor-or-self::div[1]'), build: (p) => p.getByText(/^Discounts at or above this need Finance/).locator('xpath=ancestor-or-self::div[1]'), divergence: 'DV-B5-02' },
  { proto: (p) => p.getByText(/^Credits above this need Finance/).locator('xpath=ancestor-or-self::div[1]'), build: (p) => p.getByText(/^Credits at or above this need Finance/).locator('xpath=ancestor-or-self::div[1]'), divergence: 'DV-B5-02' },
];

// DV-B5-05 — roster notes the record cannot supply or names differently: "Finance admin
// removed {date}" (no role-removal history is read, R-13) and the pending request's id and
// summary (a CR uuid shown as CR-XXXXXXXX; the summary is built from the request payload).
const ROSTER_NOTES: CcpMask[] = [
  { proto: (p) => p.getByText(/^Finance admin removed /), build: (p) => p.getByRole('row', { name: /Kwame Mensah/ }).locator('td').nth(2).getByText(/./), divergence: 'DV-B5-05' },
  // The notes column width follows those texts (auto table layout), so its header moves.
  { proto: (p) => p.locator('main th').filter({ hasText: 'Notes' }), build: (p) => p.locator('main th').filter({ hasText: 'Notes' }), divergence: 'DV-B5-05' },
  { proto: (p) => p.getByText(/^Pending CR-1045/), build: (p) => p.getByText(/^Pending CR-/), divergence: 'DV-B5-05', textBox: true, padRight: 60 },
];

// DV-B5-06 — the audit rows are the REAL event stream (create and submit are two events,
// codes are the backend's, ids are uuids, details are read from structured payloads), not the
// prototype's illustrative stream, and the auto table layout sizes every column from those
// rows: the table is masked; the page head, the export count and the filter row's first
// controls are compared.
const AUDIT_BODY: CcpMask = { proto: (p) => p.locator('main section').first(), build: (p) => p.locator('main section.pw-gov-card'), divergence: 'DV-B5-06', toBottom: true };
// DV-B5-06 — the actor and event-type selects size to their option labels, which come from
// the event stream (real names / event codes), so the filter row after the product select
// shifts with the data.
const AUDIT_FILTERS: CcpMask = { proto: (p) => p.locator('main select').first().locator('..'), build: (p) => p.locator('.pw-aud-filters'), divergence: 'DV-B5-06', toBottom: true };

export const CCP_B5_STATES: readonly CcpState[] = [
  // ---- Policy (§5.6) ------------------------------------------------------------------
  // CCP-UI-V12 (AM-7, v1.2 D-1): the policy states are compared with CCP-UI v1.2 (the Apply window
  // (TTL) row on every version, the AM-7 activation copy); their references are re-captured from it.
  {
    name: 'ccp-policy-draft',
    clip: 'content',
    proto: { props: { release: 'v1_2', persona: 'priya', startRoute: 'policy' } },
    build: { path: '/commercial/policy', mock: { persona: 'priya' } },
    masks: THRESHOLD_HELP,
  },
  {
    name: 'ccp-policy-active',
    clip: 'content',
    proto: { props: { release: 'v1_2', persona: 'priya', startRoute: 'policy' }, call: 'c.setState({ pv: 1 })' },
    build: { path: '/commercial/policy', mock: { persona: 'priya' }, act: (p) => p.getByRole('button', { name: /^v1/ }).click() },
    masks: THRESHOLD_HELP,
  },
  {
    name: 'ccp-policy-viewonly',
    clip: 'content',
    proto: { props: { release: 'v1_2', persona: 'ines', startRoute: 'policy' } },
    build: { path: '/commercial/policy', mock: { persona: 'ines' } },
    masks: THRESHOLD_HELP,
  },
  {
    name: 'ccp-policy-activation-dialog',
    clip: 'dialog',
    blur: true,
    aaAllowance: 60,
    // v1.2's draft carries the failed activation CR-1053 (its panel offers Retry apply / Withdraw…):
    // the activation dialog is opened directly.
    proto: { props: { release: 'v1_2', persona: 'priya', startRoute: 'policy' }, call: 'c.dlgPolicy(c.state.pol.find((x) => x.v === 2))' },
    build: { path: '/commercial/policy', mock: { persona: 'priya' }, act: (p) => p.getByRole('button', { name: 'Request activation…' }).click() },
  },
  // ---- Audit (§5.7) ---------------------------------------------------------------------
  {
    name: 'ccp-audit',
    clip: 'content',
    proto: { props: { persona: 'ines', startRoute: 'audit' } },
    build: { path: '/commercial/audit', mock: { persona: 'ines' } },
    masks: [AUDIT_BODY, AUDIT_FILTERS],
  },
  // ---- Platform admins › commercial roles (§5.8) ----------------------------------------
  {
    name: 'ccp-admins',
    clip: 'content',
    proto: { props: { persona: 'daniel', startRoute: 'admins' } },
    build: { path: '/admins', mock: { persona: 'daniel' } },
    masks: ROSTER_NOTES,
  },
  {
    name: 'ccp-admins-viewonly',
    clip: 'content',
    proto: { props: { persona: 'ines', startRoute: 'admins' } },
    build: { path: '/admins', mock: { persona: 'ines' } },
    masks: ROSTER_NOTES,
  },
  {
    name: 'ccp-admins-role-dialog',
    clip: 'dialog',
    blur: true,
    aaAllowance: 60,
    proto: { props: { persona: 'daniel', startRoute: 'admins' }, call: "c.dlgRole('ines')" },
    build: { path: '/admins', mock: { persona: 'daniel' }, act: (p) => p.getByRole('row', { name: /Ines Duarte/ }).getByRole('button', { name: 'Request role change…' }).click() },
  },
  {
    name: 'ccp-admins-last-owner',
    clip: 'dialog',
    blur: true,
    aaAllowance: 60,
    proto: { props: { persona: 'arjun', startRoute: 'admins', bootstrap: 'notBootstrapped' }, call: "c.dlgRole('arjun'); c.setVal('roles', ['finance_admin'])" },
    build: {
      path: '/admins',
      mock: { persona: 'arjun', bootstrap: 'notBootstrapped' },
      act: async (p) => {
        await p.getByRole('row', { name: /Arjun Rao/ }).getByRole('button', { name: 'Request role change…' }).click();
        await p.getByRole('dialog').getByRole('button', { name: '✓ Platform owner' }).click();
      },
    },
  },
];
