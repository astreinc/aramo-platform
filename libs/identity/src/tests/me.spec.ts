import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IdentityService } from '../lib/identity.service.js';
import type { MeContextRow } from '../lib/identity.repository.js';

// Aramo-Identity-Me-Endpoint-UserMenu-Directive-v1_0 — GET /v1/me self-read.
//
// Proves the service-layer resolution that the (apps/api) MeController exposes:
//   - own-membership only (no membership → null → the controller's 404);
//   - ALL the caller's roles returned, as human display names, tier-ordered;
//   - display_name null is preserved alongside email (the FE name fallback);
//   - the tenant org label falls back display_name → workspace name (never
//     empty).
// Repository is mocked (no DB) — the join itself is exercised by the repo's
// own integration coverage; here we lock the projection + ordering + fallbacks.

const ARGS = { user_id: 'u1', tenant_id: 't1' };

function makeService(ctx: MeContextRow | null) {
  const findMeContext = vi.fn(async () => ctx);
  // Only findMeContext is exercised by getMe; the audit + role-bundle deps are
  // never touched on the read path.
  const svc = new IdentityService(
    { findMeContext } as never,
    {} as never,
    {} as never,
  );
  return { svc, findMeContext };
}

function ctx(over: Partial<MeContextRow> = {}): MeContextRow {
  return {
    email: 'purush@astreinc.com',
    display_name: 'Purush Pichaimuthu',
    roles: [{ key: 'recruiter', description: null }],
    tenant_name: 'Astre',
    tenant_display_name: 'Astre Consulting Services Inc',
    ...over,
  };
}

describe('IdentityService.getMe', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keys the read on the CALLER (sub + tenant_id), nothing else', async () => {
    const { svc, findMeContext } = makeService(ctx());
    await svc.getMe(ARGS);
    expect(findMeContext).toHaveBeenCalledWith(ARGS);
  });

  it('returns null when the caller has no membership (→ 404 own-membership only)', async () => {
    const { svc } = makeService(null);
    await expect(svc.getMe(ARGS)).resolves.toBeNull();
  });

  it('returns ALL roles as display names, ordered by presentation tier', async () => {
    // Deliberately out of tier order on the way in (recruiter, an Operations
    // tier, before tenant_admin, an Administration tier) to prove the service
    // re-orders by presentation tier.
    const { svc } = makeService(
      ctx({
        roles: [
          { key: 'recruiter', description: null },
          { key: 'tenant_admin', description: null },
        ],
      }),
    );
    const view = await svc.getMe(ARGS);
    // Admin tier first, operations after — the "Tenant Admin · Recruiter" line.
    expect(view?.roles).toEqual(['Tenant Admin', 'Recruiter']);
  });

  it('resolves a role display name from its description leading phrase', async () => {
    const { svc } = makeService(
      ctx({
        roles: [
          { key: 'recruiter', description: 'Talent Recruiter — sources talent' },
        ],
      }),
    );
    const view = await svc.getMe(ARGS);
    expect(view?.roles).toEqual(['Talent Recruiter']);
  });

  it('returns [] for a membership with no active roles (no empty role line)', async () => {
    const { svc } = makeService(ctx({ roles: [] }));
    const view = await svc.getMe(ARGS);
    expect(view?.roles).toEqual([]);
  });

  it('preserves a null display_name alongside email (the FE name fallback)', async () => {
    const { svc } = makeService(ctx({ display_name: null }));
    const view = await svc.getMe(ARGS);
    expect(view?.user).toEqual({
      display_name: null,
      email: 'purush@astreinc.com',
    });
  });

  it('uses tenant display_name when set', async () => {
    const { svc } = makeService(
      ctx({ tenant_display_name: 'Astre Consulting Services Inc' }),
    );
    const view = await svc.getMe(ARGS);
    expect(view?.tenant.display_name).toBe('Astre Consulting Services Inc');
  });

  it('falls back to the workspace name when tenant display_name is null', async () => {
    const { svc } = makeService(
      ctx({ tenant_name: 'Astre', tenant_display_name: null }),
    );
    const view = await svc.getMe(ARGS);
    expect(view?.tenant.display_name).toBe('Astre');
  });
});
