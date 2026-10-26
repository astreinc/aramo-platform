// CCP-B6 — the support-extension screen-states (CCP-UI v1.0 handoff §5.9 support extension
// dialog + exception overlay, §5.10 dialog pattern, §2 view-only), rendered from the pinned
// Commercial Control Plane v1.0.dc.html (reference) and from the build on the B6 fixture dataset
// (e2e/fixtures/ccp-support.ts) at 1440×900 and 900×900. B1 owns the shell and the rail, which
// are not in this slice's base: every B6 state is ELEMENT-level (the dialog box, the overlay card,
// the view-only note). Every mask is a sanctioned divergence listed in DIVERGENCES.md (DV-B6-*).

import type { Page } from '@playwright/test';

import { sxMock, sxPath } from '../fixtures/ccp-support';

import type { Mask, ScreenState } from './state-types';

const PROTO_DIALOG = (p: Page) => p.locator('div[role="dialog"][aria-label^="Request support extension"]');
const BUILD_DIALOG = (p: Page) => p.locator('.tc-dialog__content:has(.pw-crd)');

/** DV-B6-2 — the clause help line: no "§4.2" (the policy document has no section numbers). */
const HELP: Mask = {
  proto: (p) => PROTO_DIALOG(p).locator('label span').filter({ hasText: /^Policy v1 §4\.2: / }),
  build: (p) => BUILD_DIALOG(p).locator('.pw-sxd__help'),
  divergence: 'DV-B6-2',
};
/** DV-B6-2 — the preview's "Policy clause: v1 §4.2" line, without the section number. */
const PREVIEW_CLAUSE: Mask = {
  proto: (p) => PROTO_DIALOG(p).locator('[role="status"] li').filter({ hasText: /^Policy clause: / }),
  build: (p) => BUILD_DIALOG(p).locator('[role="status"] li').filter({ hasText: /^Policy clause: / }),
  divergence: 'DV-B6-2',
};

const openExtend = async (p: Page): Promise<void> => {
  await p.getByRole('button', { name: 'Request support extension…' }).click();
  await BUILD_DIALOG(p).waitFor();
};

const PROTO_OVERLAY = (p: Page) => p.locator('main div:has(> div > span:text-is("EXCEPTION"))').first();
const BUILD_OVERLAY = (p: Page) => p.locator('.pw-xo').first();

/** DV-B6-3 — the overlay reference: the A8 row id (a UUID, shown EXT-<8 hex>), not the prototype's EXT-0042. */
const OVERLAY_REF: Mask = {
  proto: (p) => PROTO_OVERLAY(p).locator('span').filter({ hasText: /^EXT-0042$/ }),
  build: (p) => BUILD_OVERLAY(p).locator('.pw-xo__ref'),
  divergence: 'DV-B6-3',
  // "EXT-<8 hex>" is wider than "EXT-0042" (right-aligned): cover the longer reference.
  padLeft: 40,
};
/** DV-B6-2 + the retired pilot policy v0 (handoff "Don't build"): the clause names policy v1 and no section number. */
const OVERLAY_CLAUSE: Mask = {
  proto: (p) => PROTO_OVERLAY(p).locator('span:text-is("Policy clause") + span'),
  build: (p) => BUILD_OVERLAY(p).locator('dt:text-is("Policy clause") + dd'),
  divergence: 'DV-B6-2',
};

export const CCP_SUPPORT_STATES: readonly ScreenState[] = [
  {
    // Fernhill (PAST_DUE, no prior extension), the default 7 days: "Within bounds" (§5.9).
    name: 'ccp-sx-dialog-in-bounds',
    proto: { file: 'ccp', ccp: { persona: 'kwame' }, hash: 'tenant/t_fernhill', call: "c.dlgExt(c.state.tenants.find(t => t.id === 't_fernhill'), 'sign')" },
    build: { path: sxPath('fernhill'), mock: sxMock('ccpSupport'), act: openExtend },
    element: { proto: PROTO_DIALOG, build: BUILD_DIALOG },
    masks: [HELP, PREVIEW_CLAUSE],
    blur: true,
  },
  {
    // 20 days: "Out of bounds — escalates to approval (Finance)" + the Finance chain strip.
    name: 'ccp-sx-dialog-escalates',
    proto: { file: 'ccp', ccp: { persona: 'kwame' }, hash: 'tenant/t_fernhill', call: "c.dlgExt(c.state.tenants.find(t => t.id === 't_fernhill'), 'sign'); c.setVal('days', '20')" },
    build: {
      path: sxPath('fernhill'),
      mock: sxMock('ccpSupport'),
      act: async (p) => {
        await openExtend(p);
        await BUILD_DIALOG(p).getByLabel('Extension (days)').fill('20');
      },
    },
    element: { proto: PROTO_DIALOG, build: BUILD_DIALOG },
    masks: [HELP],
    blur: true,
    // AA-B6-1: the two field captions rasterise 1px apart at this dialog's fractional top
    // (194.078px); every box measured identical (DIVERGENCES.md).
    aaAllowance: 320,
  },
  {
    // Oakridge's EXT-0042: the exception overlay card (§5.9).
    name: 'ccp-sx-overlay',
    proto: { file: 'ccp', ccp: { persona: 'kwame' }, hash: 'tenant/t_oakridge' },
    build: { path: sxPath('oakridge'), mock: sxMock('ccpSupport') },
    element: { proto: PROTO_OVERLAY, build: BUILD_OVERLAY },
    masks: [OVERLAY_REF, OVERLAY_CLAUSE],
  },
  {
    // A Finance admin on the tenant: the view-only note, verbatim (§2; .dc.html td.viewOnlyText).
    name: 'ccp-sx-viewonly',
    proto: { file: 'ccp', ccp: { persona: 'priya' }, hash: 'tenant/t_oakridge' },
    build: { path: sxPath('oakridge'), mock: sxMock('ccpFinance') },
    element: {
      proto: (p) => p.locator('main div').filter({ hasText: /^View only\. You can view this tenant’s commercial state\./ }).last(),
      build: (p) => p.locator('.sx-viewonly'),
    },
  },
];
