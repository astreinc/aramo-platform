// PLATFORM-UX-1 H-1 — load every web-font face both pages use before an image is
// taken. `document.fonts.ready` resolves as soon as nothing is PENDING, which can be
// before the Google Fonts stylesheet has declared its faces or before a weight first
// used late (a dialog's 700, a chip's mono 500) has loaded: the frame then draws
// that run in a fallback face, and the reference and the build differ by a few
// hundred pixels from one run to the next.

import type { Page } from '@playwright/test';

const FACES = [
  ...[400, 500, 600, 700].map((w) => `${w} 14px "Hanken Grotesk"`),
  ...[400, 500, 600].map((w) => `${w} 14px "IBM Plex Mono"`),
];

// Every unicode-range subset the pages draw from (latin, latin-ext, the arrows and
// symbols of the Studio's keys and toolbars).
const SAMPLE = 'Aa0 €£ ÄÖÜßéñ’“” …·–—→←↑↓⇄↵↶↷⌘⌥⇧✓×⋮⋯';

export async function loadFonts(page: Page): Promise<void> {
  await page.waitForFunction(() => Array.from(document.fonts).some((f) => f.family.replace(/"/g, '') === 'Hanken Grotesk'), null, { timeout: 30_000 });
  await page.evaluate(async ([faces, sample]) => {
    await Promise.all(faces.map((f) => document.fonts.load(f, sample)));
    await document.fonts.ready;
  }, [FACES, SAMPLE] as const);
}
