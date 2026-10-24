// PLATFORM-UX-1 H-1 — paints sanctioned-divergence masks as solid #FF00FF
// rectangles. The same rectangles are painted in the reference (at capture) and
// in the build (at assert), so a masked region compares equal; any part of the
// build region that falls OUTSIDE the reference region still fails the diff.

import { readFile, writeFile } from 'node:fs/promises';

import type { Locator, Page } from '@playwright/test';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function boxesOf(locators: readonly Locator[], toBottom: readonly boolean[] = [], textBox: readonly boolean[] = [], padRight: readonly number[] = [], padLeft: readonly number[] = [], padBottom: readonly number[] = [], padTop: readonly number[] = []): Promise<Rect[]> {
  const out: Rect[] = [];
  const vh = locators.length > 0 ? (locators[0]!.page().viewportSize()?.height ?? 900) : 900;
  for (const [k, l] of locators.entries()) {
    const n = await l.count();
    for (let i = 0; i < n; i += 1) {
      const b = textBox[k]
        ? await l.nth(i).evaluate((el) => {
            const r = document.createRange();
            r.selectNodeContents(el);
            const q = r.getBoundingClientRect();
            return { x: q.x, y: q.y, width: q.width, height: q.height };
          })
        : await l.nth(i).boundingBox();
      if (b && b.width > 0 && b.height > 0) {
        const pt = padTop[k] ?? 0;
        const y = Math.floor(b.y) - pt;
        const pl = padLeft[k] ?? 0;
        out.push({ x: Math.floor(b.x) - pl, y, width: Math.ceil(b.width) + 1 + pl + (padRight[k] ?? 0), height: toBottom[k] ? Math.max(0, vh - y) : Math.ceil(b.height) + 1 + pt + (padBottom[k] ?? 0) });
      }
    }
  }
  return out;
}

export async function paint(page: Page, rects: readonly Rect[]): Promise<void> {
  if (rects.length === 0) return;
  await page.evaluate((rs) => {
    for (const r of rs) {
      const d = document.createElement('div');
      d.setAttribute('data-h1-mask', '');
      d.setAttribute('aria-hidden', 'true');
      d.style.cssText = `position:fixed;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;background:#FF00FF;z-index:2147483647;pointer-events:none`;
      document.body.appendChild(d);
    }
  }, rects);
}

export async function saveRects(file: string, rects: readonly Rect[]): Promise<void> {
  await writeFile(file, `${JSON.stringify(rects)}\n`);
}

export async function loadRects(file: string): Promise<Rect[]> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Rect[];
  } catch {
    return [];
  }
}
