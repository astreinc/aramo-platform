import express from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { describe, expect, it } from 'vitest';

import { applyTrustProxy, TRUST_PROXY_HOPS } from '../trust-proxy.js';

// Front-Door PR-1 (Ruling 5, unit lane) — the lane-gated regression guard.
// prepush's local INTEGRATION_ROOTS lacks apps/auth-service + apps/platform-admin
// (evidence item 8), so this unit spec is the only trust-proxy guard that fires in
// EVERY lane that gates (incl. local prepush). Exercises the SAME applyTrustProxy
// production boots (Ruling 2); an Express instance stands in for the Nest adapter
// (NestExpressApplication.set delegates to the underlying express app.set).
describe('applyTrustProxy (auth-service)', () => {
  it('sets trust proxy to exactly one hop', () => {
    const app = express();
    applyTrustProxy(app as unknown as NestExpressApplication);
    expect(app.get('trust proxy')).toBe(1);
  });

  it('TRUST_PROXY_HOPS is the topology constant 1 (not env-driven — Ruling 1)', () => {
    expect(TRUST_PROXY_HOPS).toBe(1);
  });
});
