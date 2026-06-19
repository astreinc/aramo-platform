import { describe, expect, it, vi } from 'vitest';

import {
  EVENT_TYPES,
  IdentityAuditRepository,
  TENANT_SCOPED_EVENT_TYPES,
} from '../lib/audit/identity-audit.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

const USER_ID = '01900000-0000-7000-8000-000000000001';
const TENANT_ID = '01900000-0000-7000-8000-0000000000aa';

function makePrisma(create: ReturnType<typeof vi.fn>): PrismaService {
  return { identityAuditEvent: { create } } as unknown as PrismaService;
}

describe('IdentityAuditRepository — PR-8.0a-Reground §6 amendment', () => {
  // Test 4: 4 new event_types accepted without closed-set violation.
  it('accepts the 4 new session.* event_types without throwing', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'r' });
    const repo = new IdentityAuditRepository(makePrisma(create));

    const newTypes = [
      'identity.session.issued',
      'identity.session.refreshed',
      'identity.session.revoked',
      'identity.session.reuse_detected',
    ] as const;

    for (const event_type of newTypes) {
      await expect(
        repo.writeEvent({
          event_type,
          actor_type: 'user',
          actor_id: USER_ID,
          tenant_id: TENANT_ID,
          subject_id: USER_ID,
          event_payload: {},
        }),
      ).resolves.toMatchObject({ id: expect.any(String) });
    }
    expect(create).toHaveBeenCalledTimes(4);
  });

  // Test 5: each new event_type is recorded with tenant_id set (tenant-scoped).
  it('writes the 4 new session.* event_types with tenant_id set', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'r' });
    const repo = new IdentityAuditRepository(makePrisma(create));

    const newTypes = [
      'identity.session.issued',
      'identity.session.refreshed',
      'identity.session.revoked',
      'identity.session.reuse_detected',
    ] as const;

    for (const event_type of newTypes) {
      await repo.writeEvent({
        event_type,
        actor_type: 'user',
        actor_id: USER_ID,
        tenant_id: TENANT_ID,
        subject_id: USER_ID,
        event_payload: {},
      });
    }

    for (const call of create.mock.calls) {
      const arg = call[0] as { data: { tenant_id: string | null } };
      expect(arg.data.tenant_id).toBe(TENANT_ID);
    }
  });

  // Schema/catalog test 47: EVENT_TYPES tuple now contains 26 values; arbitrary
  // strings are still rejected.
  // AUTHZ-2: +2 invitation lifecycle events (11 -> 13).
  // AUTHZ-D4a: +9 team-model substrate events (13 -> 22).
  // Settings S2: +1 tenant_setting.updated event (22 -> 23).
  // Settings S3a: +1 tenant_user.disabled event (23 -> 24).
  // Settings S3b: +2 tenant_user.role_assigned + tenant_user.role_removed (24 -> 26).
  // Settings D3: +1 tenant_profile.updated (26 -> 27).
  it('EVENT_TYPES contains 27 values (7 prereq + 4 session + 2 invitation + 9 D4a team-model + 1 settings + 3 user-lifecycle + 1 tenant-profile) and rejects unlisted', async () => {
    expect(EVENT_TYPES).toHaveLength(27);
    const create = vi.fn().mockResolvedValue({ id: 'r' });
    const repo = new IdentityAuditRepository(makePrisma(create));

    await expect(
      repo.writeEvent({
        event_type: 'identity.session.bogus' as never,
        actor_type: 'user',
        actor_id: USER_ID,
        tenant_id: TENANT_ID,
        subject_id: USER_ID,
        event_payload: {},
      }),
    ).rejects.toThrow(/event_type outside closed set/);
    expect(create).not.toHaveBeenCalled();
  });

  // Schema/catalog test 48: tenant-scoped index covers all 21 tenant-scoped
  // types. AUTHZ-2 adds invitation.created + invitation.accepted (6 -> 8);
  // AUTHZ-D4a adds 9 team-model substrate events (8 -> 17); Settings S2 adds
  // tenant_setting.updated (17 -> 18); Settings S3a adds
  // tenant_user.disabled (18 -> 19); Settings S3b adds tenant_user.
  // role_assigned + tenant_user.role_removed (19 -> 21).
  // Settings D3 adds tenant_profile.updated (21 -> 22).
  it('TENANT_SCOPED_EVENT_TYPES contains all 22 tenant-scoped values', () => {
    const expected = [
      'identity.tenant.created',
      'identity.membership.created',
      'identity.session.issued',
      'identity.session.refreshed',
      'identity.session.revoked',
      'identity.session.reuse_detected',
      'identity.invitation.created',
      'identity.invitation.accepted',
      // AUTHZ-D4a — 9 team-model substrate events.
      'identity.management_edge.set',
      'identity.management_edge.cleared',
      'identity.team.created',
      'identity.team.membership.added',
      'identity.team.membership.removed',
      'identity.team.client_ownership.added',
      'identity.team.client_ownership.removed',
      'identity.user_client_assignment.created',
      'identity.user_client_assignment.removed',
      // Settings S2 — tenant-config write event.
      'identity.tenant_setting.updated',
      // Settings S3a — tenant-user lifecycle DISABLE event.
      'identity.tenant_user.disabled',
      // Settings S3b — tenant-user role-assign events (per-delta gating).
      'identity.tenant_user.role_assigned',
      'identity.tenant_user.role_removed',
      // Settings D3 — tenant-profile update event.
      'identity.tenant_profile.updated',
    ];
    expect(TENANT_SCOPED_EVENT_TYPES.size).toBe(22);
    for (const t of expected) {
      expect(TENANT_SCOPED_EVENT_TYPES.has(t as never)).toBe(true);
    }
  });

  // Index-mapping enforcement: tenant-scoped event with null tenant_id is rejected.
  it('rejects a tenant-scoped session event written with null tenant_id', async () => {
    const create = vi.fn();
    const repo = new IdentityAuditRepository(makePrisma(create));

    await expect(
      repo.writeEvent({
        event_type: 'identity.session.issued',
        actor_type: 'user',
        actor_id: USER_ID,
        tenant_id: null,
        subject_id: USER_ID,
        event_payload: {},
      }),
    ).rejects.toThrow(/tenant-scoped/);
    expect(create).not.toHaveBeenCalled();
  });
});
