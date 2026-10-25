// CCP-B1 — drives the pinned CCP design file (Commercial Control Plane v1.0.dc.html,
// release CCP-UI v1.0, committed byte-identical under doc/design-reference/ccp/
// CCP-UI-v1_0 with its MANIFEST.sha256) to a screen-state for the reference image.
// Same method as support/proto.ts (PLATFORM-UX-1 §3.3): served on the synthetic
// origin, its own Tweaks set through the file's prop defaults, then the logic
// instance is captured as `window.__pi` so protoState / protoCall work on it.
//
// Prototype-only elements are removed BEFORE render (handoff "Don't build"):
//   - the dashed "PROTOTYPE — NOT AUTHORIZED FOR BUILD" chip in the environment bar;
//   - the Prototype rail group (Screen inventory, Open questions);
//   - the ↗ link-out marks on rail items and the rail's NEW tag;
//   - the retired pilot policy v0 and every request created under it (CR-1039,
//     CR-1046, CR-1047, CR-1048, CR-1050, CR-1038): policy numbering starts at v1;
//   - Tweaks (persona, bootstrap, demoState, startRoute) are prop defaults only.
// The account-menu persona switcher and the "simulate Stripe webhook" button are
// never opened by a captured state.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Page } from '@playwright/test';

import { loadFonts } from './fonts';
import { settle } from './proto';

const DIR = resolve(__dirname, '../../../../doc/design-reference/ccp/CCP-UI-v1_0');
const ORIGIN = 'http://proto-ccp.test';
const FILE = 'Commercial Control Plane v1.0.dc.html';

export interface CcpProtoProps {
  /** ccp-data.js PEOPLE: daniel (owner, default), priya (finance), tomas, lena, kwame, ines, arjun, maya (super admin). */
  persona?: 'daniel' | 'priya' | 'tomas' | 'lena' | 'kwame' | 'ines' | 'arjun' | 'maya';
  bootstrap?: 'ready' | 'notBootstrapped';
  demoState?: 'normal' | 'loading' | 'empty';
  /** CCP-B5 (folded in at the merge train, TD-MERGE-13): the prototype's start route Tweak. */
  startRoute?: 'approvals' | 'subs' | 'catalog' | 'contracts' | 'policy' | 'audit' | 'admins';
}

const STRIPS: readonly (readonly [string, string])[] = [
  [
    `<span style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.06em;border:1px dashed #0B1022;border-radius:4px;padding:1px 7px">PROTOTYPE — NOT AUTHORIZED FOR BUILD</span>`,
    '',
  ],
  ["  ['Prototype', [['inventory','Screen inventory',null,IC.list],['questions','Open questions',null,IC.help]]],\n", ''],
  [`<sc-if value="{{ n.ext }}" hint-placeholder-val="{{ false }}"><span aria-hidden="true" style="margin-left:auto;font-size:11px;color:#91939C">↗</span></sc-if>`, ''],
  [
    `<sc-if value="{{ g.isNew }}" hint-placeholder-val="{{ false }}"><span style="font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.06em;color:#F0B49E;border:1px solid #D97757;border-radius:3px;padding:0 4px">NEW</span></sc-if>`,
    '',
  ],
];

/**
 * The release pin (doc/ccp/design-inputs.md): every byte served is checked against the
 * copy's MANIFEST.sha256 (folded in from the CCP-B2 opener at the merge train, TD-MERGE-5).
 */
async function verifiedBytes(name: string): Promise<Buffer> {
  const buf = await readFile(resolve(DIR, name));
  const manifest = await readFile(resolve(DIR, 'MANIFEST.sha256'), 'utf8');
  const want = manifest
    .split('\n')
    .map((l) => l.trim().split(/\s+/, 2))
    .find(([, f]) => f === name)?.[0];
  if (want !== undefined && createHash('sha256').update(buf).digest('hex') !== want) throw new Error(`${name} does not match the pinned CCP-UI v1.0 manifest`);
  return buf;
}

function patchHtml(src: string, props: CcpProtoProps): string {
  let s = src;
  const q = '&quot;';
  const setDefault = (prop: string, from: string, to: string): void => {
    const needle = `${q}${prop}${q}:{`;
    const at = s.indexOf(needle);
    if (at < 0) throw new Error(`CCP prototype prop ${prop} not found`);
    const end = s.indexOf('}', at);
    const seg = s.slice(at, end).replace(`${q}default${q}:${from}`, `${q}default${q}:${to}`);
    s = s.slice(0, at) + seg + s.slice(end);
  };
  if (props.persona) setDefault('persona', `${q}daniel${q}`, `${q}${props.persona}${q}`);
  if (props.bootstrap) setDefault('bootstrap', `${q}ready${q}`, `${q}${props.bootstrap}${q}`);
  if (props.demoState) setDefault('demoState', `${q}normal${q}`, `${q}${props.demoState}${q}`);
  if (props.startRoute) setDefault('startRoute', `${q}approvals${q}`, `${q}${props.startRoute}${q}`);
  for (const [from, to] of STRIPS) {
    if (!s.includes(from)) throw new Error(`CCP prototype strip target not found: ${from.slice(0, 60)}`);
    s = s.split(from).join(to);
  }
  return s;
}

/** Opens the CCP design file at `hash` (approvals by default) and captures its logic instance. */
export async function openCcpProto(page: Page, props: CcpProtoProps = {}, hash = ''): Promise<void> {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
    const buf = await verifiedBytes(name);
    if (name.endsWith('.html')) {
      await route.fulfill({ body: patchHtml(buf.toString('utf8'), props), contentType: 'text/html; charset=utf-8' });
    } else {
      await route.fulfill({ body: buf, contentType: name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    }
  });
  await page.goto(`${ORIGIN}/${encodeURIComponent(FILE)}${hash ? `#${hash}` : ''}`);
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
  // Drop the retired pilot policy v0 and the requests created under it (Don't build).
  await page.evaluate(() => {
    const inst = (window as unknown as { __pi: { state: { crs: { policy: number }[]; pol: { v: number }[] }; setState: (x: unknown) => void } }).__pi;
    inst.setState({ crs: inst.state.crs.filter((c) => c.policy !== 0), pol: inst.state.pol.filter((p) => p.v !== 0) });
  });
  await settle(page);
}

/**
 * CCP-B5 (folded in at the merge train, TD-MERGE-13) — runs a function against the prototype's
 * logic instance `c` (open a dialog, select a version…), then settles.
 */
export async function ccpCall(page: Page, fnSrc: string): Promise<void> {
  await page.evaluate((src) => {
    const inst = (window as unknown as { __pi: unknown }).__pi;
    new Function('c', src)(inst);
  }, fnSrc);
  await settleCcp(page);
}

/** CCP-B5 — fonts loaded, two animation frames, fonts ready. */
export async function settleCcp(page: Page): Promise<void> {
  await loadFonts(page);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
  await page.evaluate(() => document.fonts.ready);
}
