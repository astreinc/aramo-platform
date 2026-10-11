import { AramoError } from '@aramo/common';
import { describe, expect, it } from 'vitest';

import { resolveAuthorizeCapability } from '../microsoft/microsoft-authorization.controller.js';

// COMM-C2B Amendment A1 (R4) — the opt-in scheduling capability on authorize/start is a
// CLOSED enum, fail-closed: omitted/empty/'baseline' keep the baseline posture; only an
// explicit 'scheduling' widens to Calendars.ReadWrite; any other value is rejected.

describe('resolveAuthorizeCapability (authorize/start opt-in guard)', () => {
  it('omitted / empty / "baseline" → undefined (baseline posture, unchanged)', () => {
    expect(resolveAuthorizeCapability(undefined, 'rq')).toBeUndefined();
    expect(resolveAuthorizeCapability('', 'rq')).toBeUndefined();
    expect(resolveAuthorizeCapability('baseline', 'rq')).toBeUndefined();
  });

  it('"scheduling" → the explicit opt-in capability', () => {
    expect(resolveAuthorizeCapability('scheduling', 'rq')).toBe('scheduling');
  });

  it('any other value FAILS CLOSED with a 400 validation error (never coerced to baseline or elevated)', () => {
    for (const bad of ['Scheduling', 'calendars', 'admin', 'write', 'true', 'baseline ']) {
      let caught: unknown;
      try { resolveAuthorizeCapability(bad, 'rq'); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(AramoError);
      expect((caught as AramoError).statusCode).toBe(400);
    }
  });
});
