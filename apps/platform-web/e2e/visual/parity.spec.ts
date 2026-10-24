// PLATFORM-UX-1 H-1 — visual parity (directive §3): the BUILD, on the fixture
// dataset and the prototype's frozen clock, against the design-file reference
// for every screen-state at 1440×900 and 900×900. Masks are ONLY the typed,
// directive-sanctioned divergences listed in DIVERGENCES.md.

import { expect, test } from '@playwright/test';

import { resolve } from 'node:path';

import { openBuild, settleBuild } from '../support/build';
import { boxesOf, loadRects, paint } from '../support/masks';
import { VIEWPORTS } from './state-types';
import { STATES } from './states';

const ONLY = process.env['PW_STATE'];
const SHOTS = resolve(__dirname, '__screenshots__');

for (const s of STATES) {
  if (ONLY && !s.name.includes(ONLY)) continue;
  for (const vp of VIEWPORTS) {
    if (s.viewports && !s.viewports.includes(vp.name)) continue;
    test(`${s.name} @${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const mock = typeof s.build.mock === 'function' ? s.build.mock() : (s.build.mock ?? {});
      await openBuild(page, s.build.path, { ...mock, railCollapsed: s.railCollapsed === true });
      if (s.build.act) await s.build.act(page);
      // Park the pointer in the bottom-right corner (a static image carries no
      // hover) and take the image at the top of the page.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.mouse.move(vp.width - 1, vp.height - 1);
      if (s.blur) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await settleBuild(page);
      if (s.frozen) {
        // Frozen shared component (see DIVERGENCES.md): assert the copy/state,
        // not the pixels.
        test.info().annotations.push({ type: 'frozen', description: s.frozen });
        if (s.frozenCheck) await s.frozenCheck(page);
        return;
      }
      const buildRects = await boxesOf((s.masks ?? []).map((m) => m.build(page)), (s.masks ?? []).map((m) => m.toBottom === true), (s.masks ?? []).map((m) => m.textBox === true));
      const protoRects = await loadRects(resolve(SHOTS, `${s.name}-${vp.name}.masks.json`));
      await paint(page, [...protoRects, ...buildRects]);
      await expect(page).toHaveScreenshot(`${s.name}-${vp.name}.png`, process.env['PW_STRICT'] ? { maxDiffPixels: 0, ...(process.env['PW_THRESHOLD'] ? { threshold: Number(process.env['PW_THRESHOLD']) } : {}) } : {});
    });
  }
}
