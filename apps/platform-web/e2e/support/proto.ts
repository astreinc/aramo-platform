// PLATFORM-UX-1 H-1 — drives the design file (Platform Admin.dc.html) to a
// screen-state for the reference screenshot.
//
// The file is served from disk through `page.route` on a synthetic origin
// (http://proto.test/) rather than file://: its runtime (support.js) fetches its
// own source, which Chromium refuses on the file scheme (the onboarding funnel
// and the rail icons then never resolve). Same bytes, same Chromium.
//
// Prototype-only elements are removed BEFORE render through the file's own
// switches (handoff "Don't build"):
//   - showAnnotations=false → no dashed NEEDS BACKEND tags, no "Prototype only"
//     sign-in box, no Provision hint;
//   - the Handoff nav group (Components & questions) is dropped from NAV;
//   - the Tweaks panel only renders in the design tool's edit mode (never here).
// A residual stylesheet (STRIP_CSS) hides anything still prototype-only.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Page } from '@playwright/test';

const DIR = resolve(__dirname, '../../../../doc/design-reference/platform-admin/platform');
const ORIGIN = 'http://proto.test';

export interface ProtoProps {
  persona?: 'operator' | 'auditor' | 'tenantUser';
  demoState?: 'ready' | 'loading' | 'empty' | 'error';
}

function patchHtml(src: string, props: ProtoProps): string {
  let s = src;
  const q = '&quot;';
  const setDefault = (prop: string, from: string, to: string): void => {
    const needle = `${q}${prop}${q}:{`;
    const at = s.indexOf(needle);
    if (at < 0) throw new Error(`prototype prop ${prop} not found`);
    const end = s.indexOf('}', at);
    const seg = s.slice(at, end).replace(`${q}default${q}:${from}`, `${q}default${q}:${to}`);
    s = s.slice(0, at) + seg + s.slice(end);
  };
  setDefault('showAnnotations', 'true', 'false');
  if (props.persona) setDefault('persona', `${q}operator${q}`, `${q}${props.persona}${q}`);
  if (props.demoState) setDefault('demoState', `${q}ready${q}`, `${q}${props.demoState}${q}`);
  // Drop the prototype-only Handoff page from the rail and the ⌘K "Pages".
  s = s.replace(/\s*\['Handoff', \[\['spec','Components & questions',null,IC\.spec\]\]\]/, '');
  s = s.replace("['Platform', [['admins','Platform admins','platform:admin:invite',IC.key]]],", "['Platform', [['admins','Platform admins','platform:admin:invite',IC.key]]]");
  return s;
}

const STRIP_CSS = `
  /* Belt and braces: any dashed prototype tag left visible. */
  [title="Kind is dropped from the list DTO today"] { display: none !important; }
`;

export async function openProto(page: Page, props: ProtoProps = {}, hash = ''): Promise<void> {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
    const buf = await readFile(resolve(DIR, name));
    if (name.endsWith('.html')) {
      await route.fulfill({ body: patchHtml(buf.toString('utf8'), props), contentType: 'text/html; charset=utf-8' });
    } else {
      await route.fulfill({ body: buf, contentType: name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    }
  });
  await page.goto(`${ORIGIN}/Platform%20Admin.dc.html${hash ? `#${hash}` : ''}`);
  await page.waitForFunction(() => document.querySelector('[aria-label="Skip to content"], a[href="#main"]') !== null && document.fonts.status === 'loaded', null, { timeout: 30_000 });
  await page.addStyleTag({ content: STRIP_CSS });
  await page.waitForFunction(() => {
    const w = window as unknown as { __pi?: unknown };
    const el = document.querySelector('a[href="#main"]');
    if (!el) return false;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return false;
    type F = { return: F | null; stateNode: { logic?: { state?: { tenants?: unknown } } } | null };
    let f = (el as unknown as Record<string, F>)[key] ?? null;
    while (f) {
      const logic = f.stateNode && f.stateNode.logic;
      if (logic && logic.state && logic.state.tenants) {
        w.__pi = logic;
        return true;
      }
      f = f.return;
    }
    return false;
  });
  await settle(page);
}

/** Merges a state patch into the prototype's logic component. */
export async function protoState(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate((p) => {
    const inst = (window as unknown as { __pi: { setState: (x: unknown) => void } }).__pi;
    inst.setState(p);
  }, patch);
  await settle(page);
}

/** Runs a function against the prototype's logic instance (e.g. open a dialog). */
export async function protoCall(page: Page, fnSrc: string): Promise<void> {
  await page.evaluate((src) => {
    const inst = (window as unknown as { __pi: unknown }).__pi;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('c', src)(inst);
  }, fnSrc);
  await settle(page);
}

export async function settle(page: Page): Promise<void> {
  // The account menu's prototype-only "Components & open questions" (Handoff page).
  await page.evaluate(() => {
    for (const a of Array.from(document.querySelectorAll('[role="menuitem"]'))) {
      if (a.textContent?.trim() === 'Components & open questions') (a as HTMLElement).style.display = 'none';
    }
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
  await page.evaluate(() => document.fonts.ready);
}
