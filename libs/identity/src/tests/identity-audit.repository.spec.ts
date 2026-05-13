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

  // Schema/catalog test 47: EVENT_TYPES tuple now contains 11 values; arbitrary
  // strings are still rejected.
  it('EVENT_TYPES contains 11 values (7 prereq + 4 new) and rejects unlisted', async () => {
    expect(EVENT_TYPES).toHaveLength(11);
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

  // Schema/catalog test 48: tenant-scoped index covers all 6 tenant-scoped types.
  it('TENANT_SCOPED_EVENT_TYPES contains all 6 tenant-scoped values', () => {
    const expected = [
      'identity.tenant.created',
      'identity.membership.created',
      'identity.session.issued',
      'identity.session.refreshed',
      'identity.session.revoked',
      'identity.session.reuse_detected',
    ];
    expect(TENANT_SCOPED_EVENT_TYPES.size).toBe(6);
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
