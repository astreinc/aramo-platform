// PLATFORM-UX-1 H-1 — opens the BUILD (the real platform-web app) on a route with
// the fixture provider and the prototype's frozen clock.

import type { Page } from '@playwright/test';

import { mockApi, type MockOptions, type MockTracker } from '../fixtures/mock-api';
import { NOW_ISO } from '../fixtures/tenants';
import { loadFonts } from './fonts';

export async function openBuild(page: Page, path: string, opts: MockOptions & { railCollapsed?: boolean } = {}): Promise<void> {
  await page.clock.setFixedTime(new Date(NOW_ISO));
  const tracker = await mockApi(page, opts);
  (page as unknown as { __mock?: MockTracker }).__mock = tracker;
  await page.addInitScript((collapsed) => {
    try {
      window.localStorage.setItem('rc-rail-collapsed', collapsed ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }, opts.railCollapsed === true);
  await page.goto(path);
  await page.waitForLoadState('load');
  await settleBuild(page);
}

/** Waits until the app has had every (non-hung) API answer and React has painted. */
export async function settleBuild(page: Page): Promise<void> {
  const tracker = (page as unknown as { __mock?: MockTracker }).__mock;
  let quiet = 0;
  for (let i = 0; i < 100 && quiet < 3; i += 1) {
    await page.waitForTimeout(50);
    quiet = tracker && tracker.pending() > 0 ? 0 : quiet + 1;
  }
  await loadFonts(page);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
}
