import { describe, expect, it } from 'vitest';

import { SEED_SCOPE_KEYS } from '../lib/dto/scope.dto.js';
import { ROLE_SCOPE_ASSIGNMENTS } from '../../prisma/seed.js';

// FIX-PORTAL-SCOPES-1 (D2, part 2 of 2) — the in-lib half of the structural parity
// guard. Both sides derived PROGRAMMATICALLY:
//   - defined side: the portal:* subset of SEED_SCOPE_KEYS (the scope catalog).
//   - granted side: the portal:* grants of the portal role in ROLE_SCOPE_ASSIGNMENTS
//     (the role→scope seed mapping). The portal role is found STRUCTURALLY — the one
//     role whose entire grant list is portal:* — never by a hardcoded role key.
//
// Pins DEFINED ≡ GRANTED. Its companion (session-scope-parity.spec, apps/auth-service)
// pins the JWT's PORTAL_SESSION_SCOPES ≡ DEFINED. Transitively: session ≡ role-grant
// (the Lead-ruled anchor). A future portal scope that is defined-but-not-granted (or
// granted-but-not-defined) turns this red before it can silently ship.

const definedPortal = SEED_SCOPE_KEYS.filter((s) => s.startsWith('portal:'));

// The portal role: the ONE ROLE_SCOPE_ASSIGNMENTS entry whose grants are entirely
// portal:* (the seed's portal-user role). Found by property, not by name.
const portalRoleGrants = Object.values(ROLE_SCOPE_ASSIGNMENTS).find(
  (scopes) => scopes.length > 0 && scopes.every((s) => s.startsWith('portal:')),
);

describe('FIX-PORTAL-SCOPES-1 — defined portal:* ≡ role-granted portal:* parity', () => {
  it('a portal-user role exists (grants are entirely portal:*)', () => {
    expect(portalRoleGrants).toBeDefined();
  });

  it('the portal role is granted EXACTLY the defined portal:* scope set', () => {
    const granted = (portalRoleGrants ?? []).filter((s) => s.startsWith('portal:'));
    expect([...granted].sort()).toEqual([...definedPortal].sort());
  });
});
