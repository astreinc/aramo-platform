import { describe, it, expect } from 'vitest';

import { OFFER_SEED_ROLE_SCOPE_ROW_IDS } from '../../prisma/seed.js';

// HF-SEED-OFFER-ID — regression guard for the prod P2002 collision that STOPPED the
// 2026-09-02 release at seed STAGE B.
//
// L4/P5 widened the offer bundles from 2 -> 4 scopes/role. The grant-id map was
// allocated by ONE role-major positional counter (`let i = 0xc40`), so widening the
// per-role run shifted every id after the first role. A genuinely NEW (role,scope) pair
// then created with an id an EXISTING prod row already owned: recruiter:offer:read landed
// on 0xc42, which prod holds for account_manager:offer:create -> P2002 on an already-seeded
// DB. A fresh CI database has no pre-existing rows, so CI was blind; only prod caught it.
//
// The fix keeps the two ORIGINAL scopes (offer:create / offer:transition) on their
// pre-L4/P5 ids 0xc40..0xc47 (so re-seeding prod matches existing rows and never creates
// over them) and puts the two ADDED scopes (offer:read / offer:read:financial) in the
// FRESH sub-range 0xc48..0xc4f (the reserved offer block is 0xc40..0xc4f; COMM starts
// 0xc50). This guard pins that layout so no future bundle-widening can silently shift an
// existing id onto a live row again.

const oid = (n: number): string =>
  `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const ORIGINAL_IDS: Record<string, number> = {
  'recruiter:offer:create': 0xc40,
  'recruiter:offer:transition': 0xc41,
  'account_manager:offer:create': 0xc42,
  'account_manager:offer:transition': 0xc43,
  'tenant_admin:offer:create': 0xc44,
  'tenant_admin:offer:transition': 0xc45,
  'tenant_owner:offer:create': 0xc46,
  'tenant_owner:offer:transition': 0xc47,
};

const ADDED_KEYS = [
  'recruiter:offer:read',
  'recruiter:offer:read:financial',
  'account_manager:offer:read',
  'account_manager:offer:read:financial',
  'tenant_admin:offer:read',
  'tenant_admin:offer:read:financial',
  'tenant_owner:offer:read',
  'tenant_owner:offer:read:financial',
];

describe('HF-SEED-OFFER-ID — offer RoleScope grant id stability (prod P2002 regression)', () => {
  it('pins the 8 ORIGINAL offer grants to their prod-established ids 0xc40..0xc47', () => {
    for (const [key, n] of Object.entries(ORIGINAL_IDS)) {
      expect(OFFER_SEED_ROLE_SCOPE_ROW_IDS[key], `${key} must keep its prod id ${oid(n)}`).toBe(
        oid(n),
      );
    }
  });

  it('allocates the 8 ADDED offer grants to the FRESH sub-range 0xc48..0xc4f, never onto an original id', () => {
    const originalIds = new Set(Object.values(ORIGINAL_IDS).map(oid));
    for (const key of ADDED_KEYS) {
      const id = OFFER_SEED_ROLE_SCOPE_ROW_IDS[key];
      expect(id, `${key} must be allocated`).toBeDefined();
      expect(originalIds.has(id as string), `${key} id ${id} must NOT reuse an original-scope id`).toBe(
        false,
      );
      const suffix = parseInt((id as string).slice(-12), 16);
      expect(suffix, `${key} id must be >= 0xc48`).toBeGreaterThanOrEqual(0xc48);
      expect(suffix, `${key} id must be <= 0xc4f (inside the reserved offer block)`).toBeLessThanOrEqual(
        0xc4f,
      );
    }
  });

  it('assigns a UNIQUE id to every offer grant (no two role,scope pairs share a row id)', () => {
    const ids = Object.values(OFFER_SEED_ROLE_SCOPE_ROW_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
