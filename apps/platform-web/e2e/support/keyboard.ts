// PLATFORM-UX-1 H-1 — keyboard-only driving: Tab / Shift+Tab / Enter / Space /
// Escape / arrows, and typing into the focused field. No clicks.

import { expect, type Locator, type Page } from '@playwright/test';

async function isFocused(target: Locator): Promise<boolean> {
  return target
    .first()
    .evaluate((el) => el === document.activeElement || el.contains(document.activeElement))
    .catch(() => false);
}

/** Presses Tab (or Shift+Tab) until `target` holds focus; fails after `max` presses. */
export async function tabTo(page: Page, target: Locator, opts: { max?: number; back?: boolean } = {}): Promise<void> {
  await expect(target.first()).toBeVisible();
  const max = opts.max ?? 80;
  for (let i = 0; i < max; i += 1) {
    if (await isFocused(target)) {
      await expectFocusVisible(page);
      return;
    }
    await page.keyboard.press(opts.back ? 'Shift+Tab' : 'Tab');
  }
  throw new Error(`tabTo: ${String(target)} never received focus after ${max} presses`);
}

/** Tab to it, then Enter. */
export async function activate(page: Page, target: Locator, key: 'Enter' | 'Space' = 'Enter'): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press(key === 'Space' ? ' ' : 'Enter');
}

/** Tab to a field, then type into it. */
export async function typeInto(page: Page, target: Locator, text: string): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.type(text);
}

/** WCAG 2.4.7 — the focused element shows a visible indicator (outline or ring). */
export async function expectFocusVisible(page: Page): Promise<void> {
  const r = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { ok: false, what: 'body' };
    const cs = getComputedStyle(el);
    const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
    const ring = cs.boxShadow !== 'none' && cs.boxShadow !== '';
    return { ok: outline || ring, what: `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? '').trim().slice(0, 30)}" outline=${cs.outlineStyle} ${cs.outlineWidth} shadow=${cs.boxShadow}` };
  });
  expect(r.ok, `focus not visible on ${r.what}`).toBe(true);
}

/** The element that holds focus now, as a stable handle. */
export async function focusedHandle(page: Page) {
  return page.evaluateHandle(() => document.activeElement);
}

/** Asserts focus is back on the element that was focused before (the opener). */
export async function expectFocusReturned(page: Page, opener: Awaited<ReturnType<typeof focusedHandle>>): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((o) => {
        const a = document.activeElement as HTMLElement | null;
        return o === a ? 'opener' : `${a?.tagName ?? 'none'}.${a?.className ?? ''} "${(a?.textContent ?? '').trim().slice(0, 30)}"`;
      }, opener),
    )
    .toBe('opener');
}
