import { describe, expect, it } from 'vitest';
import { SEED_SCOPE_KEYS } from '@aramo/identity';

import { PORTAL_SESSION_SCOPES } from '../app/auth/session-orchestrator.service.js';

// FIX-PORTAL-SCOPES-1 (D2, part 1 of 2) — the STRUCTURAL parity guard that keeps
// PORTAL_SESSION_SCOPES from silently going stale again (the F-P4b-1 root cause).
//
// Both sides are derived PROGRAMMATICALLY, never hand-copied:
//   - session side: PORTAL_SESSION_SCOPES (the single source stamped on the JWT).
//   - seed side: the portal:* subset of SEED_SCOPE_KEYS (the seed's exported scope
//     catalog) — filtered here, not re-listed.
//
// This pins session ≡ the DEFINED portal:* scopes. The companion in-lib test
// (portal-role-scope-parity.spec, libs/identity) pins DEFINED ≡ the scopes the
// portal role is GRANTED (ROLE_SCOPE_ASSIGNMENTS). Transitively the two guarantee
// session ≡ the role-grant — the Lead-ruled anchor — split across the two packages
// only because ROLE_SCOPE_ASSIGNMENTS lives in prisma/seed (outside the lib's dist)
// and PORTAL_SESSION_SCOPES lives in this app; neither import crosses that boundary.

const seedPortalScopes = SEED_SCOPE_KEYS.filter((s) => s.startsWith('portal:'));

describe('FIX-PORTAL-SCOPES-1 — session ≡ seed portal:* parity', () => {
  it('PORTAL_SESSION_SCOPES carries EXACTLY the seed portal:* scope set (no drift)', () => {
    expect([...PORTAL_SESSION_SCOPES].sort()).toEqual([...seedPortalScopes].sort());
  });

  it('every portal scope the seed defines is stamped on a real portal session', () => {
    const stamped = new Set(PORTAL_SESSION_SCOPES);
    const missing = seedPortalScopes.filter((s) => !stamped.has(s));
    expect(missing).toEqual([]); // a seeded portal scope not on the session = the F-P4b-1 bug
  });

  it('no session scope is a non-portal or unseeded scope (session is portal-scoped)', () => {
    const seeded = new Set(seedPortalScopes);
    const extra = PORTAL_SESSION_SCOPES.filter((s) => !seeded.has(s));
    expect(extra).toEqual([]);
  });
});
