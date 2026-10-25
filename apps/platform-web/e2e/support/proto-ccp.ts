// CCP-B5 — drives the CCP design file (doc/design-reference/ccp/CCP-UI-v1_0/Commercial
// Control Plane v1.0.dc.html; pinned by MANIFEST.sha256, doc/ccp/slices/CCP-B5-pre-execution.md
// §5) to a screen-state for the reference screenshot. Served from disk on a synthetic origin
// (as support/proto.ts does for the PLATFORM-UX-1 file).
//
// Prototype-only elements are removed BEFORE render (handoff "Don't build"):
//   - the dashed "PROTOTYPE — NOT AUTHORIZED FOR BUILD" chip in the environment bar;
//   - the Prototype rail group (Screen inventory, Open questions);
//   - the retired pilot policy v0 and every request created under it (policy numbering
//     starts at v1, Q12) — patched out of ccp-data.js;
//   - Tweaks (persona / bootstrap / demoState / startRoute) are set through the file's own
//     prop defaults, never shown.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Page } from '@playwright/test';

import { loadFonts } from './fonts';

const DIR = resolve(__dirname, '../../../../doc/design-reference/ccp/CCP-UI-v1_0');
const ORIGIN = 'http://proto-ccp.test';
const FILE = 'Commercial Control Plane v1.0.dc.html';

export interface CcpProtoProps {
  persona?: 'maya' | 'daniel' | 'priya' | 'tomas' | 'lena' | 'kwame' | 'ines' | 'arjun';
  bootstrap?: 'ready' | 'notBootstrapped';
  demoState?: 'normal' | 'loading' | 'empty';
  startRoute?: 'approvals' | 'subs' | 'catalog' | 'contracts' | 'policy' | 'audit' | 'admins';
}

function patchHtml(src: string, props: CcpProtoProps): string {
  let s = src;
  const q = '&quot;';
  const setDefault = (prop: string, from: string, to: string): void => {
    const needle = `${q}${prop}${q}:{`;
    const at = s.indexOf(needle);
    if (at < 0) throw new Error(`prototype prop ${prop} not found`);
    const end = s.indexOf('}', at);
    const seg = s.slice(at, end);
    const next = seg.replace(`${q}default${q}:${q}${from}${q}`, `${q}default${q}:${q}${to}${q}`);
    if (next === seg && from !== to) throw new Error(`prototype prop ${prop} default ${from} not found`);
    s = s.slice(0, at) + next + s.slice(end);
  };
  if (props.persona) setDefault('persona', 'daniel', props.persona);
  if (props.bootstrap) setDefault('bootstrap', 'ready', props.bootstrap);
  if (props.demoState) setDefault('demoState', 'normal', props.demoState);
  if (props.startRoute) setDefault('startRoute', 'approvals', props.startRoute);
  const chip = '<span style="font-family:\'IBM Plex Mono\',monospace;font-size:10.5px;letter-spacing:.06em;border:1px dashed #0B1022;border-radius:4px;padding:1px 7px">PROTOTYPE — NOT AUTHORIZED FOR BUILD</span>';
  if (!s.includes(chip)) throw new Error('prototype chip not found');
  s = s.replace(chip, '');
  const group = "\n  ['Prototype', [['inventory','Screen inventory',null,IC.list],['questions','Open questions',null,IC.help]]],";
  if (!s.includes(group)) throw new Error('prototype rail group not found');
  s = s.replace(group, '');
  return s;
}

function patchData(src: string): string {
  let s = src;
  const v0 = /\n\s*\{ v:0, status:'RETIRED', note:'Pilot policy\.'[^\n]*\},/;
  if (!v0.test(s)) throw new Error('policy v0 not found');
  s = s.replace(v0, '');
  const map = '].map(c => Object.assign(c, { expires: c.created + 72 * H }));';
  if (!s.includes(map)) throw new Error('CR0 map not found');
  s = s.replace(map, '].filter(c => c.policy !== 0).map(c => Object.assign(c, { expires: c.created + 72 * H }));');
  return s;
}

export async function openCcpProto(page: Page, props: CcpProtoProps = {}): Promise<void> {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
    const buf = await readFile(resolve(DIR, name));
    if (name.endsWith('.html')) await route.fulfill({ body: patchHtml(buf.toString('utf8'), props), contentType: 'text/html; charset=utf-8' });
    else if (name === 'ccp-data.js') await route.fulfill({ body: patchData(buf.toString('utf8')), contentType: 'text/javascript' });
    else await route.fulfill({ body: buf, contentType: name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
  });
  await page.goto(`${ORIGIN}/${encodeURIComponent(FILE)}`);
  await page.waitForFunction(() => document.querySelector('a[href="#main"]') !== null && document.fonts.status === 'loaded', null, { timeout: 30_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as { __pi?: unknown };
    const el = document.querySelector('a[href="#main"]');
    if (!el) return false;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return false;
    type F = { return: F | null; stateNode: { logic?: { state?: { crs?: unknown } } } | null };
    let f = (el as unknown as Record<string, F>)[key] ?? null;
    while (f) {
      const logic = f.stateNode && f.stateNode.logic;
      if (logic && logic.state && logic.state.crs) {
        w.__pi = logic;
        return true;
      }
      f = f.return;
    }
    return false;
  });
  await settleCcp(page);
}

/** Runs a function against the prototype's logic instance `c` (open a dialog, select a version…). */
export async function ccpCall(page: Page, fnSrc: string): Promise<void> {
  await page.evaluate((src) => {
    const inst = (window as unknown as { __pi: unknown }).__pi;
    new Function('c', src)(inst);
  }, fnSrc);
  await settleCcp(page);
}

export async function settleCcp(page: Page): Promise<void> {
  await loadFonts(page);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
  await page.evaluate(() => document.fonts.ready);
}
