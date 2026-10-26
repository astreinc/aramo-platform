// CCP-B1 — the Commercial screen-states (CCP-UI v1.0 handoff §2, §3.2, §5.1, §5.2,
// §5.10), rendered from the pinned Commercial Control Plane v1.0.dc.html
// (reference) and from the build on the CCP fixture dataset (e2e/fixtures/
// commercial.ts) at 1440×900 and 900×900. Every mask is a sanctioned divergence
// listed in DIVERGENCES.md (DV-C*).

import type { Page } from '@playwright/test';

import { CR, ccpMock } from '../fixtures/commercial';

import type { Mask, ScreenState } from './state-types';
import { swap } from './masks-common';

/** DV-C1 — the rail: the build keeps the Dashboard item for commercial roles (pre-execution C-2) and the console's own rail glyphs, so every item below Operations shifts; the Commercial group itself is compared element-level (ccp-rail-group). */
const RAIL: Mask = {
  proto: (p: Page) => p.locator('nav[aria-label="Platform admin"]'),
  build: (p: Page) => p.locator('.rc-rail'),
  divergence: 'DV-C1',
};

/** DV-C2 — the ⌘K trigger keeps the console's placeholder (request results in ⌘K are not in B1, pre-execution C-8). */
const CMDK_TEXT: Mask = swap('DV-C2', 'Tenants, requests, pages', 'Tenants, skills, templates');

/** DV-C3 — inbox rows: real A3 DTO values (UUID references, requester ids, the policy version id, the payload-derived summaries) instead of the prototype's sample rows. */
const ROWS: Mask = {
  // The whole table: the auto layout sizes every column (head included) from the rows.
  proto: (p: Page) => p.locator('main table'),
  build: (p: Page) => p.locator('main table'),
  divergence: 'DV-C3',
  toBottom: true,
};

const SHELL: readonly Mask[] = [RAIL, CMDK_TEXT];

/** The drawer header's reference row (CR-1042 vs the UUID, which moves the state pill). */
const DRAWER_ID: Mask = {
  proto: (p: Page) => p.locator('aside[role="dialog"] span').filter({ hasText: /^CR-\d+$/ }).locator('..'),
  // The id and the pill only (the row itself spans the close button).
  build: (p: Page) => p.locator('.tc-dialog__content:has(.pw-drawer--ccp) .tc-dialog__description > *'),
  divergence: 'DV-C3',
};

/** DV-C4 — data the A3 routes do not carry (R-13): the requester's name and roles, the policy version number. */
const fact = (label: string): Mask => ({
  proto: (p: Page) => p.locator('aside[role="dialog"] span').filter({ hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::span[1]'),
  build: (p: Page) => p.locator('.pc-dr-facts dt').filter({ hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]'),
  divergence: 'DV-C4',
});

/** DV-C5 — the effect: the request carries the after side only (before = "—", R-13), and no evidence; every section below it shifts. */
const EFFECT_DOWN: Mask = {
  proto: (p: Page) => p.locator('aside[role="dialog"] div').filter({ hasText: /^Effect · before → after/ }).last(),
  build: (p: Page) => p.locator('.pc-dr .pw-ccp-caps').filter({ hasText: 'Effect · before → after' }).locator('..'),
  divergence: 'DV-C5',
  toBottom: true,
};

/** DV-C6 — the in-shell access-denied card keeps R-5's Missing row and Sign out, and says Back to dashboard (Amendment A1-4 › design). */
const DENIED_TAIL: Mask = {
  // From the bottom of the Grants access row (the actions row, back over the facts
  // box's 14px padding, 1px border and 18px gap) to the bottom, across the card.
  proto: (p: Page) => p.getByRole('link', { name: 'Sign in with a different account' }).locator('..'),
  build: (p: Page) => p.locator('.pw-denied__facts dt').filter({ hasText: /^Missing$/ }),
  divergence: 'DV-C6',
  toBottom: true,
  padTop: 33,
  padLeft: 33,
  padRight: 33,
};

/** DV-C7 — the reject dialog is the platform ConfirmDialog (lead brief: the from → to Change box + consequence), so it is taller than the design's plain dialog and centres at a different height: the dialog box is masked whole; its copy, fields and actions are asserted by the unit and keyboard suites. */
const DIALOG: Mask = {
  proto: (p: Page) => p.locator('div[role="dialog"][aria-modal="true"]'),
  build: (p: Page) => p.locator('.tc-dialog__content:has(.pw-cd)'),
  divergence: 'DV-C7',
  // The build dialog is taller (the Change box) and centred: grow the design's
  // region so it holds the build's (a build region outside it still fails).
  padTop: 60,
  padBottom: 60,
};

const openDrawer = (id: string) => async (p: Page) => {
  await p.getByTestId(`cr-row-${id}`).click();
  await p.getByTestId('cr-drawer').waitFor();
};

export const CCP_STATES: readonly ScreenState[] = [
  {
    name: 'ccp-approvals',
    proto: { file: 'ccp', ccp: { persona: 'priya' }, hash: 'approvals' },
    build: { path: '/commercial/approvals', mock: ccpMock({ persona: 'ccpFinance' }) },
    masks: [...SHELL, ROWS],
  },
  {
    name: 'ccp-approvals-pending',
    proto: { file: 'ccp', ccp: { persona: 'priya' }, hash: 'approvals', state: { inbox: 'pending' } },
    build: { path: '/commercial/approvals', mock: ccpMock({ persona: 'ccpFinance' }), act: async (p) => p.getByRole('tab', { name: /^All pending/ }).click() },
    masks: [...SHELL, ROWS],
  },
  {
    name: 'ccp-approvals-empty',
    proto: { file: 'ccp', ccp: { persona: 'priya', demoState: 'empty' }, hash: 'approvals' },
    build: { path: '/commercial/approvals', mock: ccpMock({ persona: 'ccpFinance', empty: true }) },
    masks: SHELL,
  },
  {
    name: 'ccp-approvals-history-empty',
    proto: { file: 'ccp', ccp: { persona: 'priya', demoState: 'empty' }, hash: 'approvals', state: { inbox: 'history' } },
    build: { path: '/commercial/approvals', mock: ccpMock({ persona: 'ccpFinance', empty: true }), act: async (p) => p.getByRole('tab', { name: /^History/ }).click() },
    masks: SHELL,
  },
  {
    name: 'ccp-approvals-loading',
    proto: { file: 'ccp', ccp: { persona: 'priya', demoState: 'loading' }, hash: 'approvals' },
    build: { path: '/commercial/approvals', mock: ccpMock({ persona: 'ccpFinance', loading: true }) },
    masks: SHELL,
  },
  {
    // DV-C8: the banner names the chains of the loaded pending requests whose
    // `chain_satisfiable` is false (the A3 routes expose no roster-wide
    // fulfillability), and "View chains" (B5's page) is not offered.
    name: 'ccp-approvals-bootstrap',
    proto: { file: 'ccp', ccp: { persona: 'priya', bootstrap: 'notBootstrapped' }, hash: 'approvals' },
    build: { path: '/commercial/approvals', mock: ccpMock({ persona: 'ccpFinance', policyRequest: true, unfulfillable: [CR.c1041, CR.c1043, CR.c1044, CR.c1045, CR.c1053] }) },
    masks: [
      ...SHELL,
      ROWS,
      // "View chains" goes to B5's page: not offered in B1.
      { proto: (p) => p.getByRole('link', { name: 'View chains' }), build: (p) => p.locator('.pw-bootbanner__action'), divergence: 'DV-C8', textBox: true },
      // The fixture adds the pending policy activation the banner names (All pending 7 vs 6).
      { proto: (p) => p.getByRole('tab', { name: /^All pending/ }).locator('span'), build: (p) => p.getByRole('tab', { name: /^All pending/ }).locator('.pc-tab__count'), divergence: 'DV-C8' },
    ],
  },
  {
    name: 'ccp-drawer',
    proto: { file: 'ccp', ccp: { persona: 'priya' }, hash: 'approvals', state: { crOpen: 'CR-1042' } },
    build: { path: '/commercial/approvals', mock: ccpMock({ persona: 'ccpFinance' }), act: openDrawer(CR.c1042) },
    masks: [RAIL, ROWS, DRAWER_ID, fact('Requested by'), fact('Policy'), EFFECT_DOWN],
    blur: true,
  },
  {
    name: 'ccp-dialog-reject',
    proto: { file: 'ccp', ccp: { persona: 'priya' }, hash: 'approvals', state: { crOpen: 'CR-1042' }, call: "c.dlgReject(c.state.crs.find(x => x.id === 'CR-1042'))" },
    build: {
      path: '/commercial/approvals',
      mock: ccpMock({ persona: 'ccpFinance' }),
      act: async (p) => {
        await openDrawer(CR.c1042)(p);
        await p.getByRole('button', { name: 'Reject…' }).click();
        await p.getByRole('dialog', { name: /^Reject / }).waitFor();
      },
    },
    masks: [RAIL, ROWS, DRAWER_ID, fact('Requested by'), fact('Policy'), EFFECT_DOWN, DIALOG],
    blur: true,
  },
  {
    // CCP-C4 — handoff §4: "While a Stripe-side request is Applying, that chip reads 'Sent to Stripe —
    // awaiting confirmation'". The prototype's finance persona signs CR-1042 (a below-threshold
    // credit), which it sends to Stripe; the build shows the same request applied by its requester and
    // pending at the provider. Element-level: the stepper only (the drawer's Apply panel and toast are
    // not built, recorded for CCP-UI v1.1).
    name: 'ccp-drawer-stripe-sent',
    proto: { file: 'ccp', ccp: { persona: 'priya' }, hash: 'approvals', state: { crOpen: 'CR-1042' }, call: "c.approve('CR-1042')" },
    build: { path: '/commercial/approvals', mock: ccpMock({ persona: 'ccpFinance', applying: [CR.c1042] }), act: async (p: Page) => {
      await p.getByRole('tab', { name: /^History/ }).click();
      await openDrawer(CR.c1042)(p);
    } },
    element: {
      proto: (p) => p.locator('aside[role="dialog"] ol[aria-label="Request state"]'),
      build: (p) => p.getByTestId('cr-drawer').locator('ol[aria-label="Request state"]'),
    },
    blur: true,
  },
  {
    name: 'ccp-denied-super-admin',
    proto: { file: 'ccp', ccp: { persona: 'maya' }, hash: 'approvals' },
    build: { path: '/commercial/approvals', mock: { persona: 'operator' } },
    masks: [...SHELL, DENIED_TAIL],
  },
  {
    // The Commercial group alone (element-level): six items, labels and glyphs.
    name: 'ccp-rail-group',
    proto: { file: 'ccp', ccp: { persona: 'priya' }, hash: 'approvals' },
    // DV-MERGE-1 (merge train TD-MERGE-32): the CCP-B6 "Support extensions" item is not in the
    // CCP-UI v1.0 rail; it is taken out of the layout for this six-item comparison only (its
    // presence and gating are asserted by commercial-visibility.spec.tsx).
    build: {
      path: '/commercial/approvals',
      mock: ccpMock({ persona: 'ccpFinance' }),
      act: async (p: Page) => {
        await p.locator('.pw-rail-group a[href="/commercial/support-extensions"]').evaluate((el) => {
          (el as HTMLElement).style.display = 'none';
        });
      },
    },
    element: {
      proto: (p) => p.locator('nav[aria-label="Platform admin"] > div').filter({ hasText: /^\s*Commercial/ }),
      build: (p) => p.locator('.pw-rail-group').filter({ hasText: /^\s*Commercial/ }),
    },
  },
];
