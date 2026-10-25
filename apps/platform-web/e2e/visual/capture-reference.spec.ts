// PLATFORM-UX-1 H-1 — writes the REFERENCE images: the design file driven to each
// screen-state, prototype-only elements stripped (support/proto.ts). Run only via
// `nx run aramo-platform-web:e2e-visual-reference` (PW_CAPTURE_REFERENCE=1); the
// images it writes are the committed baselines toHaveScreenshot compares against.

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { test } from '@playwright/test';

import { boxesOf, paint, saveRects } from '../support/masks';
import { openCcpProto } from '../support/ccp-proto';
import { openProto, openStudioProto, protoCall, protoState, settle } from '../support/proto';

import { VIEWPORTS } from './state-types';
import { STATES } from './states';

const OUT = resolve(__dirname, '__screenshots__');
const ONLY = process.env['PW_STATE'];

test.skip(process.env['PW_CAPTURE_REFERENCE'] !== '1', 'reference capture runs only on demand');

for (const s of STATES) {
  if (ONLY && !s.name.includes(ONLY)) continue;
  for (const vp of VIEWPORTS) {
    if (s.viewports && !s.viewports.includes(vp.name)) continue;
    test(`reference ${s.name} @${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      if (s.railCollapsed) {
        await page.addInitScript(() => {
          try {
            window.localStorage.setItem('aramo.platform.rail', '1');
          } catch {
            /* none */
          }
        });
      }
      if (s.proto.file === 'ccp') await openCcpProto(page, s.proto.ccp ?? {}, s.proto.hash ?? 'catalog');
      else if (s.proto.file === 'studio') await openStudioProto(page, s.proto.studio ?? {}, s.proto.hash ?? '');
      else await openProto(page, s.proto.props ?? {}, s.proto.hash ?? '');
      if (s.proto.state) await protoState(page, s.proto.state);
      if (s.proto.call) await protoCall(page, s.proto.call);
      if (s.proto.act) await s.proto.act(page);
      // Park the pointer in the bottom-right corner (a static image carries no
      // hover) and take the image at the top of the page.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.mouse.move(vp.width - 1, vp.height - 1);
      if (s.blur) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await settle(page);
      const pm = (s.masks ?? []).filter((m) => m.proto && (!m.viewport || m.viewport === vp.name));
      const rects = await boxesOf(
        pm.map((m) => m.proto!(page)),
        pm.map((m) => m.toBottom === true),
        pm.map((m) => m.textBox === true),
        pm.map((m) => m.padRight ?? 0),
        pm.map((m) => m.padLeft ?? 0),
        pm.map((m) => m.padBottom ?? 0),
        pm.map((m) => m.padTop ?? 0),
      );
      // 1px of slack around each design-file region: the build's region is
      // measured from a different DOM and may round to the neighbouring pixel.
      for (const r of rects) {
        r.x -= 1;
        r.y -= 1;
        r.width += 2;
        r.height += 2;
      }
      await saveRects(resolve(OUT, `${s.name}-${vp.name}.masks.json`), rects);
      await paint(page, rects);
      // Like toHaveScreenshot on the build side: shoot until two consecutive
      // frames are identical, so a transient raster (text drawn before the last
      // compositing pass) never becomes the baseline.
      let prev: Buffer | null = null;
      let shot: Buffer = Buffer.alloc(0);
      for (let i = 0; i < 10; i += 1) {
        shot = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });
        if (prev !== null && prev.equals(shot)) break;
        prev = shot;
        await page.waitForTimeout(100);
      }
      await writeFile(resolve(OUT, `${s.name}-${vp.name}.png`), shot);
    });
  }
}
