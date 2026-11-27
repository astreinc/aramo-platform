import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { registerServiceWorker } from './pwa';

// SIGN-FREE-PARITY-1 S8 — the service worker caches static build files only (custody rule).
// public/sw.js is a plain script; it is run here against a stand-in `self` to read its
// routing rule and to drive its fetch listener.

const ORIGIN = 'https://sign.aramo.ai';
const SW_SOURCE = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8');

type Route = 'static' | 'navigate' | 'bypass';
type Listener = (event: unknown) => void;

function loadWorker(): {
  route: (url: string, method?: string, mode?: string) => Route;
  rawRoute: (url: string, method: string, mode: string, origin: string) => Route;
  fetchListener: Listener;
} {
  const listeners: Record<string, Listener> = {};
  const fakeSelf: Record<string, unknown> = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn;
    },
  };
  new Function('self', 'caches', 'fetch', SW_SOURCE)(fakeSelf, {}, () => Promise.reject(new Error('no network in tests')));
  const fn = fakeSelf['aramoSignRouteRequest'] as (u: string, m: string, mode: string, o: string) => Route;
  const fetchListener = listeners['fetch'];
  if (fetchListener === undefined) throw new Error('sw.js registered no fetch listener');
  return {
    route: (url, method = 'GET', mode = 'cors') => fn(ORIGIN + url, method, mode, ORIGIN),
    rawRoute: fn,
    fetchListener,
  };
}

describe('sw.js routing (custody: static build files only)', () => {
  const { route, rawRoute, fetchListener } = loadWorker();

  it('caches hashed build files, fonts, icons and the favicon', () => {
    expect(route('/assets/index-abc123.js', 'GET', 'no-cors')).toBe('static');
    expect(route('/assets/workspace-9f8e.css', 'GET', 'no-cors')).toBe('static');
    expect(route('/fonts/HomemadeApple-Regular.ttf')).toBe('static');
    expect(route('/icons/icon-192.png', 'GET', 'no-cors')).toBe('static');
    expect(route('/favicon.png', 'GET', 'no-cors')).toBe('static');
  });

  it('never answers an API, sign-in or platform request', () => {
    for (const path of [
      '/v1/sign/sender/envelopes',
      '/v1/sign/sender/envelopes/0b1c/document',
      '/v1/sign/signing/abc/document',
      '/v1/sign/inbox',
      '/v1/sign/me/signature',
      '/auth/sign/session',
      '/auth/sign/callback?code=x',
      '/.well-known/assetlinks.json',
      '/sw.js',
      '/manifest.webmanifest',
    ]) {
      expect(route(path), path).toBe('bypass');
      expect(route(path, 'GET', 'navigate'), path).toBe('bypass');
    }
  });

  it('never answers a guest page (signing, signed copy, copy, QES return, legacy token link)', () => {
    for (const path of ['/s/tok123', '/d/tok123', '/c/tok123', '/qes/callback', '/?token=abc']) {
      expect(route(path, 'GET', 'navigate'), path).toBe('bypass');
    }
    // A guest page's own fetches carry the token too and are not answered.
    expect(route('/s/tok123/x', 'GET', 'cors')).toBe('bypass');
  });

  it('sends workspace page loads to the network first (offline page as fallback)', () => {
    expect(route('/', 'GET', 'navigate')).toBe('navigate');
    expect(route('/envelopes', 'GET', 'navigate')).toBe('navigate');
    expect(route('/legal/terms', 'GET', 'navigate')).toBe('navigate');
  });

  it('leaves writes, other origins and unknown paths alone', () => {
    expect(route('/assets/index-abc123.js', 'POST')).toBe('bypass');
    expect(route('/something-else.json')).toBe('bypass');
    expect(route('/index.html')).toBe('bypass');
    expect(rawRoute('https://fonts.gstatic.com/assets/x.woff2', 'GET', 'cors', ORIGIN)).toBe('bypass');
    expect(rawRoute('not a url', 'GET', 'cors', ORIGIN)).toBe('bypass');
  });

  it('the fetch listener does not call respondWith for a bypassed request', () => {
    for (const url of ['/s/tok123', '/v1/sign/sender/envelopes']) {
      const respondWith = vi.fn();
      fetchListener({ request: { url: ORIGIN + url, method: 'GET', mode: 'navigate' }, respondWith });
      expect(respondWith, url).not.toHaveBeenCalled();
    }
    const respondWith = vi.fn();
    fetchListener({ request: { url: 'https://fonts.gstatic.com/s/x.woff2', method: 'GET', mode: 'cors' }, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  });
});

describe('registerServiceWorker', () => {
  function host(readyState: DocumentReadyState): {
    nav: { serviceWorker: { register: ReturnType<typeof vi.fn> } };
    win: { addEventListener: ReturnType<typeof vi.fn>; document: { readyState: DocumentReadyState } };
  } {
    return {
      nav: { serviceWorker: { register: vi.fn().mockResolvedValue(undefined) } },
      win: { addEventListener: vi.fn(), document: { readyState } },
    };
  }

  it('does nothing outside production builds', () => {
    const h = host('complete');
    expect(registerServiceWorker(false, h.nav as never, h.win as never)).toBe(false);
    expect(h.nav.serviceWorker.register).not.toHaveBeenCalled();
  });

  it('does nothing where service workers are unavailable', () => {
    const h = host('complete');
    expect(registerServiceWorker(true, {}, h.win as never)).toBe(false);
  });

  it('registers /sw.js at the root scope once the page has loaded', () => {
    const h = host('loading');
    expect(registerServiceWorker(true, h.nav as never, h.win as never)).toBe(true);
    expect(h.nav.serviceWorker.register).not.toHaveBeenCalled();
    const [event, onLoad] = h.win.addEventListener.mock.calls[0] as [string, () => void];
    expect(event).toBe('load');
    onLoad();
    expect(h.nav.serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });
});
