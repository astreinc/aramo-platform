// M365-SCHED-1 visual-regression harness — capture driver.
// Renders CANONICAL (resolved .dc.html fragment, file://) and IMPLEMENTATION (real
// production components via the ATS Web vite harness) under identical Chromium
// conditions and writes screenshots for side-by-side + diff. No design substitution.

import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '__screens');
const CANON = 'file://' + join(HERE, 'canonical', 'schedule-dialog.html');
const HARNESS = 'http://localhost:4201/visual/harness/index.html';

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1920', width: 1920, height: 1080 },
];
// state → harness query (canonical currently covers the dialog only)
const STATES = [{ state: 'dialog', canon: CANON, impl: `${HARNESS}?state=dialog` }];

async function settle(page) {
  await page.evaluate(async () => {
    // @ts-ignore
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  });
  await page.waitForTimeout(400); // Radix portal mount + webfont paint
}

const browser = await chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    for (const s of STATES) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
      });
      for (const [kind, url] of [['canonical', s.canon], ['impl', s.impl]]) {
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: 'networkidle' });
        await settle(page);
        const path = join(OUT, `${s.state}-${kind}-${vp.name}.png`);
        await page.screenshot({ path });
        console.log(`wrote ${path}`);
        await page.close();
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
