// CCP-B2 — drives the pinned CCP design file (CCP-UI v1.0: Commercial Control Plane v1.0.dc.html,
// copied byte-for-byte to doc/design-reference/platform-admin/ccp/CCP-UI-v1_0/, MANIFEST.sha256
// verified) to a screen-state for the reference screenshot. Same synthetic-origin approach as
// support/proto.ts. Prototype-only elements are removed BEFORE render (CCP handoff "Don't build"):
//   - the persona Tweak is set through the file's own default (never the account-menu switcher);
//   - the dashed "PROTOTYPE — NOT AUTHORIZED FOR BUILD" chip is hidden (STRIP_CSS).
// The Prototype rail group and the ↗ link-outs live in the rail, which every CCP-B2 state masks
// until CCP-B1 lands the Commercial rail group (DIVERGENCES.md DV-B2-01).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Page } from '@playwright/test';

import { loadFonts } from './fonts';
import { settle } from './proto';

const DIR = resolve(__dirname, '../../../../doc/design-reference/platform-admin/ccp/CCP-UI-v1_0');
const ORIGIN = 'http://proto.test';
const FILE = 'Commercial Control Plane v1.0.dc.html';

export type CcpPersona = 'daniel' | 'priya' | 'tomas' | 'lena' | 'kwame' | 'ines' | 'arjun' | 'maya';

export interface CcpProtoProps {
  persona?: CcpPersona;
}

/** The release pin (doc/ccp/design-inputs.md): every byte served is checked against it. */
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
  const q = '&quot;';
  if (!props.persona || props.persona === 'daniel') return src;
  const needle = `${q}persona${q}:{`;
  const at = src.indexOf(needle);
  if (at < 0) throw new Error('prototype prop persona not found');
  const end = src.indexOf('}', at);
  const seg = src.slice(at, end).replace(`${q}default${q}:${q}daniel${q}`, `${q}default${q}:${q}${props.persona}${q}`);
  return src.slice(0, at) + seg + src.slice(end);
}

const STRIP_CSS = `
  [role="banner"] > span:nth-child(3) { display: none !important; }
`;

export async function openCcpProto(page: Page, props: CcpProtoProps = {}, hash = 'catalog'): Promise<void> {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
    const buf = await verifiedBytes(name);
    if (name.endsWith('.html')) await route.fulfill({ body: patchHtml(buf.toString('utf8'), props), contentType: 'text/html; charset=utf-8' });
    else await route.fulfill({ body: buf, contentType: name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
  });
  await page.goto(`${ORIGIN}/${encodeURIComponent(FILE)}${hash ? `#${hash}` : ''}`);
  await page.waitForFunction(() => document.querySelector('nav[aria-label="Platform admin"]') !== null && document.fonts.status === 'loaded', null, { timeout: 30_000 });
  await page.addStyleTag({ content: STRIP_CSS });
  await page.waitForFunction(() => {
    const w = window as unknown as { __pi?: unknown };
    const el = document.querySelector('nav[aria-label="Platform admin"]');
    if (!el) return false;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return false;
    type F = { return: F | null; stateNode: { logic?: { state?: { plans?: unknown } } } | null };
    let f = (el as unknown as Record<string, F>)[key] ?? null;
    while (f) {
      const logic = f.stateNode && f.stateNode.logic;
      if (logic && logic.state && logic.state.plans) {
        w.__pi = logic;
        return true;
      }
      f = f.return;
    }
    return false;
  });
  await loadFonts(page);
  await settle(page);
}
