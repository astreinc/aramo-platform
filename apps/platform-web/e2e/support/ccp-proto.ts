// CCP-B4 — drives the pinned CCP design file (CCP-UI v1.0, Commercial Control
// Plane v1.0.dc.html; MANIFEST.sha256 verified in doc/ccp/slices/CCP-B4-pre-
// execution.md) to a screen-state for a reference image, the same way
// support/proto.ts drives the PLATFORM-UX-1 file: served from disk on a
// synthetic origin, the defaults of its props patched BEFORE render.
//
// Prototype-only elements (handoff "Don't build") never reach a B4 reference:
// the B4 images are cropped to the page content (<main>) or to the dialog, and
// the prototype-only items live in the shell (environment-bar chip, persona
// switcher, Prototype rail group) — outside every crop.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Page } from '@playwright/test';

import { settle } from './proto';

const DIR = resolve(__dirname, '../../../../doc/design-reference/ccp/CCP-UI-v1_0');
const ORIGIN = 'http://ccp-proto.test';
const FILE = 'Commercial Control Plane v1.0.dc.html';

export interface CcpProtoProps {
  persona?: 'daniel' | 'priya' | 'tomas' | 'lena' | 'kwame' | 'ines' | 'arjun' | 'maya';
  demoState?: 'normal' | 'loading' | 'empty';
  startRoute?: 'approvals' | 'subs' | 'catalog' | 'contracts' | 'policy' | 'audit' | 'admins' | 'tenant';
}

function patchHtml(src: string, props: CcpProtoProps): string {
  let s = src;
  const q = '&quot;';
  const setDefault = (prop: string, to: string): void => {
    const needle = `${q}${prop}${q}:{`;
    const at = s.indexOf(needle);
    if (at < 0) throw new Error(`prototype prop ${prop} not found`);
    const end = s.indexOf('}', at);
    const seg = s.slice(at, end).replace(new RegExp(`${q}default${q}:${q}[a-zA-Z]+${q}`), `${q}default${q}:${q}${to}${q}`);
    s = s.slice(0, at) + seg + s.slice(end);
  };
  if (props.persona) setDefault('persona', props.persona);
  if (props.demoState) setDefault('demoState', props.demoState);
  if (props.startRoute) setDefault('startRoute', props.startRoute);
  return s;
}

export async function openCcpProto(page: Page, props: CcpProtoProps = {}): Promise<void> {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
    const buf = await readFile(resolve(DIR, name));
    if (name.endsWith('.html')) {
      await route.fulfill({ body: patchHtml(buf.toString('utf8'), props), contentType: 'text/html; charset=utf-8' });
    } else {
      await route.fulfill({ body: buf, contentType: name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    }
  });
  await page.goto(`${ORIGIN}/${encodeURIComponent(FILE)}`);
  await page.waitForFunction(() => document.querySelector('main#main h1') !== null && document.fonts.status === 'loaded', null, { timeout: 30_000 });
  // Capture the logic instance (window.__pi) for protoState / protoCall.
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
  await settle(page);
}
