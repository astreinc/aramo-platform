// CCP-B5 — visual parity of the governance screens against the CCP design file
// (PLATFORM-UX-1 §3 standard, applied per Amendment A1-5 with the CCP-UI v1.0 release pinned
// in doc/ccp/slices/CCP-B5-pre-execution.md §5).
//
//   PW_CAPTURE_REFERENCE=1 → writes the references (the design file driven to each state,
//                            prototype-only elements stripped) into __screenshots__;
//   otherwise              → the BUILD on the fixture dataset and the prototype's frozen
//                            clock is compared with them (threshold 0.2, 25 px, as the
//                            PLATFORM-UX-1 suite; masks only the typed DIVERGENCES.md ones).
//
// The comparison clip is the slice-owned region (ccp-b5-states.ts, DV-B5-01).

import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

import { ccpMock } from '../fixtures/ccp-governance';
import { openBuild, settleBuild } from '../support/build';
import { boxesOf, loadRects, paint, saveRects, type Rect } from '../support/masks';
import { ccpCall, openCcpProto, settleCcp } from '../support/proto-ccp';
import { CCP_B5_STATES, type CcpState } from './ccp-b5-states';
import { VIEWPORTS } from './state-types';

const SHOTS = resolve(__dirname, '__screenshots__');
const ONLY = process.env['PW_STATE'];
const CAPTURE = process.env['PW_CAPTURE_REFERENCE'] === '1';
const RAIL_W = 236;
const TOP = 30 + 56; // environment bar + top bar

async function clipOf(page: Page, s: CcpState, vp: { width: number; height: number }): Promise<Rect> {
  if (s.clip === 'content') return { x: RAIL_W, y: TOP, width: vp.width - RAIL_W, height: vp.height - TOP };
  const box = await page.getByRole('dialog').first().boundingBox();
  if (box === null) throw new Error('dialog not visible');
  return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
}

for (const s of CCP_B5_STATES) {
  if (ONLY && !s.name.includes(ONLY)) continue;
  for (const vp of VIEWPORTS) {
    if (s.viewports && !s.viewports.includes(vp.name)) continue;
    const file = `${s.name}-${vp.name}`;
    test(`${CAPTURE ? 'reference ' : ''}${s.name} @${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      if (CAPTURE) {
        await openCcpProto(page, s.proto.props);
        if (s.proto.call) await ccpCall(page, s.proto.call);
      } else {
        await openBuild(page, s.build.path, ccpMock(s.build.mock));
        if (s.build.act) await s.build.act(page);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.mouse.move(vp.width - 1, vp.height - 1);
      if (s.blur) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      if (CAPTURE) await settleCcp(page);
      else await settleBuild(page);
      const clip = await clipOf(page, s, vp);
      const masks = s.masks ?? [];
      if (CAPTURE) {
        const rects = await boxesOf(
          masks.map((m) => m.proto(page)),
          masks.map((m) => m.toBottom === true),
          masks.map((m) => m.textBox === true),
          masks.map((m) => m.padRight ?? 0),
        );
        for (const r of rects) {
          r.x -= 1;
          r.y -= 1;
          r.width += 2;
          r.height += 2;
        }
        await saveRects(resolve(SHOTS, `${file}.masks.json`), rects);
        await paint(page, rects);
        let prev: Buffer | null = null;
        let shot: Buffer = Buffer.alloc(0);
        for (let i = 0; i < 10; i += 1) {
          shot = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css', clip });
          if (prev !== null && prev.equals(shot)) break;
          prev = shot;
          await page.waitForTimeout(100);
        }
        await writeFile(resolve(SHOTS, `${file}.png`), shot);
        return;
      }
      const buildRects = await boxesOf(
        masks.map((m) => m.build(page)),
        masks.map((m) => m.toBottom === true),
        masks.map((m) => m.textBox === true),
        masks.map((m) => m.padRight ?? 0),
      );
      await paint(page, [...(await loadRects(resolve(SHOTS, `${file}.masks.json`))), ...buildRects]);
      await expect(page).toHaveScreenshot(`${file}.png`, { clip, ...(process.env['PW_STRICT'] ? { maxDiffPixels: 0 } : s.aaAllowance !== undefined ? { maxDiffPixels: s.aaAllowance } : {}) });
    });
  }
}
