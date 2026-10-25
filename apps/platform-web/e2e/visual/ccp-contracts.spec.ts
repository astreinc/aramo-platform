// CCP-B4 — visual parity of Commercial › Contracts (handoff §5.5) against the
// pinned CCP design (CCP-UI v1.0), at 1440×900 and 900×900, on the fixture
// dataset (e2e/fixtures/contracts.ts = the design's C0 data) and the frozen clock.
//
// Scope of the image: the page CONTENT (<main>, from its top to the bottom of the
// viewport) or, for a dialog state, the dialog box. The shell (rail, top bar,
// environment bar) is the PLATFORM-UX-1 shell plus the Commercial rail group,
// which CCP-B1 owns and proves; B4 does not edit it (TD-B4-6).
//
// PW_CAPTURE_REFERENCE=1 writes the reference images from the design file
// (`ccp-contracts-<state>-<viewport>.png` + `.masks.json`); otherwise the build is
// compared against them with the suite's toHaveScreenshot settings. Masks are
// ONLY the typed DV-B4-* divergences in DIVERGENCES.md.

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { CONTRACT_IDS, contractsMock, type CcpPersona } from '../fixtures/contracts';
import { openBuild, settleBuild } from '../support/build';
import { openCcpProto, type CcpProtoProps } from '../support/proto-ccp';
import { boxesOf, loadRects, paint, saveRects, type Rect } from '../support/masks';
import { protoCall, protoState, settle } from '../support/proto';

import { VIEWPORTS } from './state-types';

const SHOTS = resolve(__dirname, '__screenshots__');
const CAPTURE = process.env['PW_CAPTURE_REFERENCE'] === '1';
const ONLY = process.env['PW_STATE'];

interface B4Mask {
  readonly divergence: string;
  readonly proto: (p: Page) => Locator;
  readonly build: (p: Page) => Locator;
  readonly toBottom?: boolean;
  readonly pad?: number;
}

interface B4State {
  readonly name: string;
  readonly target: 'main' | 'dialog';
  readonly proto: { props: CcpProtoProps; state?: Record<string, unknown>; call?: string };
  readonly build: { persona: CcpPersona; list?: 'ready' | 'empty' | 'hang'; act?: (p: Page) => Promise<void> };
  readonly masks?: readonly B4Mask[];
}

// DV-B4-1 — the amendments timeline of a contract whose prototype history has
// entries the record model does not hold (a legacy "Contract recorded" before a
// migration; free-form amendment titles).
const TIMELINE: B4Mask = {
  divergence: 'DV-B4-1',
  proto: (p) => p.locator('main#main h3', { hasText: 'Amendments' }).locator('xpath=following-sibling::ol[1]'),
  build: (p) => p.locator('main .ccp-tl'),
  toBottom: true,
  pad: 21,
};
// DV-B4-2 — the chain strip: the server resolves SUBSCRIPTION_CHANGE / _END to the
// Finance-only chain (TD-A3-2); the policy version is not readable by B4 (TD-B4-2).
const CHAIN: B4Mask = {
  divergence: 'DV-B4-2',
  proto: (p) => p.locator('[role="dialog"] span', { hasText: 'Approval chain' }).locator('xpath=..'),
  build: (p) => p.locator('[role="dialog"] .ccp-chain'),
};
// DV-B4-3 — End contract: the end does not revoke the entitlement (A7, TD-A6-8),
// so the sub line and the second diff row say so (TD-B4-5).
const END_COPY: B4Mask[] = [
  { divergence: 'DV-B4-3', proto: (p) => p.locator('[role="dialog"] h2 + p'), build: (p) => p.locator('[role="dialog"] .ccp-dlg__head p') },
  {
    divergence: 'DV-B4-3',
    proto: (p) => p.locator('[role="dialog"] div', { hasText: /^Before → after/ }).locator('xpath=./div[2]/div[2]'),
    build: (p) => p.locator('[role="dialog"] .ccp-diff__row').nth(1),
  },
];

const selectRow = (ref: string) => async (p: Page) => {
  await p.getByRole('button', { name: new RegExp(ref) }).click();
  await settleBuild(p);
};
const openDialog = (label: string) => async (p: Page) => {
  await p.getByRole('button', { name: label }).click();
  await settleBuild(p);
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
};

const STATES: readonly B4State[] = [
  { name: 'ccp-contracts-ops', target: 'main', proto: { props: { persona: 'tomas', startRoute: 'contracts' } }, build: { persona: 'tomas' }, masks: [TIMELINE] },
  { name: 'ccp-contracts-view-only', target: 'main', proto: { props: { persona: 'ines', startRoute: 'contracts' } }, build: { persona: 'ines' }, masks: [TIMELINE] },
  { name: 'ccp-contracts-ended', target: 'main', proto: { props: { persona: 'tomas', startRoute: 'contracts' }, state: { ct: 'CT-2024-019' } }, build: { persona: 'tomas', act: selectRow('CT-2024-019') } },
  { name: 'ccp-contracts-empty', target: 'main', proto: { props: { persona: 'tomas', startRoute: 'contracts', demoState: 'empty' } }, build: { persona: 'tomas', list: 'empty' } },
  { name: 'ccp-contracts-loading', target: 'main', proto: { props: { persona: 'tomas', startRoute: 'contracts', demoState: 'loading' } }, build: { persona: 'tomas', list: 'hang' } },
  {
    name: 'ccp-contracts-amend-dialog',
    target: 'dialog',
    proto: { props: { persona: 'tomas', startRoute: 'contracts' }, call: "c.dlgContract('amend', window.CCP.C0[0]);" },
    build: { persona: 'tomas', act: openDialog('Record amendment…') },
    masks: [CHAIN],
  },
  {
    name: 'ccp-contracts-end-dialog',
    target: 'dialog',
    proto: { props: { persona: 'tomas', startRoute: 'contracts' }, call: "c.dlgContract('end', window.CCP.C0[0]);" },
    build: { persona: 'tomas', act: openDialog('End contract…') },
    masks: [CHAIN, ...END_COPY],
  },
];

async function clipOf(page: Page, target: B4State['target'], vh: number): Promise<Rect> {
  const sel = target === 'dialog' ? '[role="dialog"]' : 'main';
  const b = await page.locator(sel).first().boundingBox();
  if (b === null) throw new Error(`no ${sel} to crop`);
  const x = Math.floor(b.x);
  const y = Math.floor(b.y);
  return { x, y, width: Math.ceil(b.width), height: Math.min(Math.ceil(b.height), vh - y) };
}

async function maskRects(page: Page, masks: readonly B4Mask[], side: 'proto' | 'build'): Promise<Rect[]> {
  const out: Rect[] = [];
  for (const m of masks) {
    const rects = await boxesOf([side === 'proto' ? m.proto(page) : m.build(page)], [m.toBottom === true], [false], [m.pad ?? 0], [m.pad ?? 0]);
    out.push(...rects);
  }
  return out;
}

for (const s of STATES) {
  if (ONLY && !s.name.includes(ONLY)) continue;
  for (const vp of VIEWPORTS) {
    test(`${CAPTURE ? 'reference ' : ''}${s.name} @${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const masks = s.masks ?? [];
      if (CAPTURE) {
        await openCcpProto(page, s.proto.props);
        if (s.proto.state) await protoState(page, s.proto.state);
        if (s.proto.call) await protoCall(page, s.proto.call);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.mouse.move(vp.width - 1, vp.height - 1);
        await settle(page);
        const rects = (await maskRects(page, masks, 'proto')).map((r) => ({ x: r.x - 1, y: r.y - 1, width: r.width + 2, height: r.height + 2 }));
        await saveRects(resolve(SHOTS, `${s.name}-${vp.name}.masks.json`), rects);
        await paint(page, rects);
        const clip = await clipOf(page, s.target, vp.height);
        let prev: Buffer | null = null;
        let shot: Buffer = Buffer.alloc(0);
        for (let i = 0; i < 10; i += 1) {
          shot = await page.screenshot({ clip, animations: 'disabled', caret: 'hide', scale: 'css' });
          if (prev !== null && prev.equals(shot)) break;
          prev = shot;
          await page.waitForTimeout(100);
        }
        await writeFile(resolve(SHOTS, `${s.name}-${vp.name}.png`), shot);
        return;
      }
      await openBuild(page, '/commercial/contracts', contractsMock(s.build.persona, s.build.list ?? 'ready'));
      if (s.build.act) await s.build.act(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.mouse.move(vp.width - 1, vp.height - 1);
      await settleBuild(page);
      const protoRects = await loadRects(resolve(SHOTS, `${s.name}-${vp.name}.masks.json`));
      await paint(page, [...protoRects, ...(await maskRects(page, masks, 'build'))]);
      const clip = await clipOf(page, s.target, vp.height);
      await expect(page).toHaveScreenshot(`${s.name}-${vp.name}.png`, { clip });
    });
  }
}

test('ccp-contracts fixtures name the design contracts', () => {
  expect(Object.keys(CONTRACT_IDS)).toEqual(['CT-2024-007', 'CT-2026-021', 'CT-2025-014', 'CT-2024-019']);
});
