// PLATFORM-UX-1 H-1 — the 900px pass (directive §3.1, §7; handoff §15):
//   - no horizontal PAGE scroll on any screen-state at 900×900;
//   - a table wider than its card scrolls inside the card (an overflow-x
//     auto/scroll ancestor inside the page), never the page;
//   - the rail collapses below 900px (the design's `narrow` = innerWidth < 900)
//     and stays expanded at exactly 900 (the design's 900×900 frames).

import { expect, test } from '@playwright/test';

import { studioMock } from '../fixtures/templates';
import { openBuild, settleBuild } from '../support/build';
import { STATES } from '../visual/states';

const ONLY = process.env['PW_STATE'];

for (const s of STATES) {
  if (ONLY && !s.name.includes(ONLY)) continue;
  test(`900px ${s.name}`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    const mock = typeof s.build.mock === 'function' ? s.build.mock() : (s.build.mock ?? {});
    await openBuild(page, s.build.path, { ...mock, railCollapsed: s.railCollapsed === true });
    if (s.build.act) await s.build.act(page);
    await settleBuild(page);
    const r = await page.evaluate(() => {
      const doc = document.scrollingElement as HTMLElement;
      const tables = Array.from(document.querySelectorAll('main table')).map((t) => {
        const tw = t.getBoundingClientRect().width;
        let p = t.parentElement;
        let scroller: string | null = null;
        while (p && p !== document.body) {
          const ox = getComputedStyle(p).overflowX;
          if (ox === 'auto' || ox === 'scroll') {
            scroller = p.className || p.tagName;
            break;
          }
          p = p.parentElement;
        }
        const card = t.closest('section, [class*="card"]') as HTMLElement | null;
        const cw = card ? card.getBoundingClientRect().width : window.innerWidth;
        return { tw, cw, scroller };
      });
      return { pageScroll: doc.scrollWidth - doc.clientWidth, tables };
    });
    expect(r.pageScroll, 'horizontal page scroll (px)').toBeLessThanOrEqual(0);
    for (const t of r.tables) {
      if (t.tw > t.cw + 1) expect(t.scroller, `table ${t.tw}px in a ${t.cw}px card has no in-card scroller`).not.toBeNull();
    }
  });
}

test('rail: expanded at 900px, collapsed below 900px', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await openBuild(page, '/');
  const rail = page.locator('.rc-rail');
  expect(Math.round((await rail.boundingBox())!.width)).toBe(236);
  await page.setViewportSize({ width: 899, height: 900 });
  await settleBuild(page);
  expect(Math.round((await rail.boundingBox())!.width)).toBe(64);
  await page.setViewportSize({ width: 600, height: 900 });
  await settleBuild(page);
  expect(Math.round((await rail.boundingBox())!.width)).toBe(64);
  const pageScroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(pageScroll).toBeLessThanOrEqual(0);
});

test('Template Studio sizes to the viewport at 900px: no page scroll, panels as overlays', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await openBuild(page, '/document-templates/dt_01J5OFFR', studioMock());
  const r = await page.evaluate(() => {
    const doc = document.scrollingElement as HTMLElement;
    const root = document.querySelector('.pws-root')!.getBoundingClientRect();
    return { x: doc.scrollWidth - doc.clientWidth, y: doc.scrollHeight - doc.clientHeight, bottom: root.bottom, right: root.right };
  });
  expect(r.x, 'horizontal page scroll').toBeLessThanOrEqual(0);
  expect(r.y, 'vertical page scroll (the Studio scrolls inside its panes)').toBeLessThanOrEqual(0);
  expect(Math.round(r.bottom)).toBe(900);
  expect(Math.round(r.right)).toBe(900);
  // Below 1280 / 1100 the outline and the inspector start closed and open as overlays.
  await expect(page.getByRole('complementary', { name: 'Template structure' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Toggle inspector' }).dispatchEvent('click');
  const insp = page.getByRole('complementary', { name: 'Inspector' });
  await expect(insp).toHaveCSS('position', 'fixed');
  const pageScroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(pageScroll).toBeLessThanOrEqual(0);
});
