// PLATFORM-UX-1 H-1 — the test-only fixture provider (directive §3.3): every
// /auth/platform/* and /platform/* request the build makes is answered here with
// Playwright `page.route`, from the deterministic dataset in this folder. Nothing
// here ships: src/ never imports e2e/.

import type { Page, Route } from '@playwright/test';

import { meBody, sessionBody, type Persona } from './session';
import { dashboard, tenantAudit, tenantDetail, tenantDomain, tenantSign, tenantSummaries } from './tenants';
import { REST_HANDLERS } from './rest';
import { TEMPLATE_HANDLERS } from './templates';

export type Reply = { status?: number; body?: unknown } | 'hang';
export type Handler = (req: { method: string; path: string; query: URLSearchParams; body: unknown }) => Reply | undefined;

export interface MockOptions {
  persona?: Persona;
  /** Path-pattern overrides, checked before the defaults (first match wins). */
  overrides?: { method?: string; path: RegExp; reply: Reply | Handler }[];
  /** `/platform/me` refused (403) — the designed identity fallback. */
  meRefused?: boolean;
  /** Session is unauthenticated (401). */
  signedOut?: boolean;
}

const json = (body: unknown, status = 200): Reply => ({ status, body });
const notFound = (): Reply => json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);

const TENANT_HANDLERS: [string, RegExp, Handler][] = [
  ['GET', /^\/platform\/dashboard$/, () => json(dashboard())],
  ['GET', /^\/platform\/tenants$/, () => json({ tenants: tenantSummaries() })],
  ['GET', /^\/platform\/tenants\/([^/]+)$/, ({ path }) => {
    const d = tenantDetail(decodeURIComponent(path.split('/')[3]!));
    return d ? json(d) : notFound();
  }],
  ['GET', /^\/platform\/tenants\/([^/]+)\/audit$/, ({ path }) => json(tenantAudit(decodeURIComponent(path.split('/')[3]!)))],
  ['GET', /^\/platform\/tenants\/([^/]+)\/sign$/, ({ path }) => json(tenantSign(decodeURIComponent(path.split('/')[3]!)))],
  ['GET', /^\/platform\/tenants\/([^/]+)\/domain$/, ({ path }) => json(tenantDomain(decodeURIComponent(path.split('/')[3]!)))],
];

export interface MockTracker {
  /** API requests received and not yet answered (hung requests excluded). */
  pending(): number;
  /** Every request seen, `METHOD path`. */
  readonly log: string[];
}

export async function mockApi(page: Page, opts: MockOptions = {}): Promise<MockTracker> {
  let inflight = 0;
  const log: string[] = [];
  const persona = opts.persona ?? 'operator';
  const handle = async (route: Route): Promise<void> => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    let body: unknown = undefined;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    const ctx = { method, path, query: url.searchParams, body };
    log.push(`${method} ${path}${url.search}`);

    let reply: Reply | undefined;
    for (const o of opts.overrides ?? []) {
      if ((o.method ?? 'GET') === method && o.path.test(path)) {
        reply = typeof o.reply === 'function' ? o.reply(ctx) : o.reply;
        if (reply !== undefined) break;
      }
    }
    if (reply === undefined) {
      if (path === '/auth/platform/session') {
        reply = opts.signedOut ? json({ error: { code: 'UNAUTHENTICATED' } }, 401) : json(sessionBody(persona));
      } else if (path === '/auth/platform/login-options') {
        reply = json({ providers: ['microsoft', 'google'] });
      } else if (path === '/platform/me') {
        reply = opts.meRefused || persona === 'tenantUser' ? json({ error: { code: 'FORBIDDEN' } }, 403) : json(meBody(persona));
      } else {
        for (const [m, re, h] of [...TENANT_HANDLERS, ...TEMPLATE_HANDLERS, ...REST_HANDLERS]) {
          if (m === method && re.test(path)) {
            reply = h(ctx);
            if (reply !== undefined) break;
          }
        }
      }
    }
    if (reply === 'hang') return; // never answered: the loading / skeleton state
    const answer: Exclude<Reply, 'hang'> = reply ?? (notFound() as Exclude<Reply, 'hang'>);
    inflight += 1;
    try {
      await route.fulfill({ status: answer.status ?? 200, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) });
    } finally {
      inflight -= 1;
    }
  };
  await page.route((u) => /^\/(platform|auth)\//.test(u.pathname), async (route) => {
    // Only API calls — never the SPA document or a Vite module.
    const t = route.request().resourceType();
    if (t === 'document' || t === 'script' || t === 'stylesheet') return route.fallback();
    return handle(route);
  });
  return { pending: () => inflight, log };
}
