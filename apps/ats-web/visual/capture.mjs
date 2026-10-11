// M365-SCHED-1 visual-regression harness — capture driver (all four surfaces).
// Renders CANONICAL (resolved .dc.html fragments, file://) and IMPLEMENTATION (real
// production components via the ATS Web vite harness) under identical Chromium
// conditions and writes screenshots for side-by-side + diff. No design substitution.

import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '__screens');
const canon = (f) => 'file://' + join(HERE, 'canonical', f);
const HARNESS = 'http://localhost:4201/visual/harness/index.html';

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1920', width: 1920, height: 1080 },
];
// Each surface: canonical fragment file + harness ?state + optional pre-screenshot action.
const STATES = [
  { state: 'dialog', canon: 'schedule-dialog.html', impl: 'dialog' },
  { state: 'card', canon: 'card.html', impl: 'card' },
  { state: 'upcoming', canon: 'upcoming.html', impl: 'upcoming' },
  { state: 'cancel', canon: 'cancel.html', impl: 'upcoming', action: async (p) => {
      await p.getByTestId('upcoming-cancel-m1').click();
      await p.getByTestId('upcoming-cancel-confirm').waitFor();
    } },
];

async function settle(page) {
  await page.evaluate(async () => { if (document.fonts && document.fonts.ready) await document.fonts.ready; });
  await page.waitForTimeout(400);
}

const browser = await chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    for (const s of STATES) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      for (const [kind, url, action] of [['canonical', canon(s.canon), null], ['impl', `${HARNESS}?state=${s.impl}`, s.action]]) {
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: 'networkidle' });
        await settle(page);
        if (action) { await action(page); await page.waitForTimeout(300); }
        await page.screenshot({ path: join(OUT, `${s.state}-${kind}-${vp.name}.png`) });
        await page.close();
      }
      await ctx.close();
      console.log(`captured ${s.state} @ ${vp.name}`);
    }
  }
} finally {
  await browser.close();
}
