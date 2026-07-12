import { describe, expect, it, vi } from 'vitest';
import { PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';

import { TenantService } from '../lib/tenant.service.js';
import type { TenantRepository } from '../lib/tenant.repository.js';
import type { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
import type { AuditEventRow } from '../lib/audit/identity-audit.repository.js';

// Inc-3 PR-3.8 (A) — the dashboard assembly's mapping logic, unit-tested against
// mocked repository + audit service (no Postgres). Proves: status zero-fill, the
// sentinel-exclusion arg, oldest-first invited mapping, cross-tenant name
// resolution, and reason-code extraction from the three payload shapes.

function makeService(overrides: {
  counts: { status: string; count: number }[];
  onboarding: { id: string; name: string; created_at: string }[];
  invited: Record<string, boolean>;
  activity: AuditEventRow[];
  names: Map<string, string>;
}): {
  service: TenantService;
  countSpy: ReturnType<typeof vi.fn>;
} {
  const countSpy = vi.fn(async () => overrides.counts);
  const tenantRepo = {
    countTenantsByStatus: countSpy,
    findOnboardingProvisioned: vi.fn(async () => overrides.onboarding),
    findNamesByIds: vi.fn(async () => overrides.names),
  } as unknown as TenantRepository;
  const audit = {
    hasTenantEvent: vi.fn(async (tenant_id: string) => overrides.invited[tenant_id] ?? false),
    getRecentTenantLifecycleActivity: vi.fn(async () => overrides.activity),
  } as unknown as IdentityAuditService;
  return { service: new TenantService(tenantRepo, audit), countSpy };
}

function row(partial: Partial<AuditEventRow>): AuditEventRow {
  return {
    id: 'e',
    tenant_id: 't1',
    actor_id: 'a',
    actor_type: 'user',
    event_type: 'tenant.suspended',
    subject_id: 't1',
    event_payload: {},
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    ...partial,
  } as AuditEventRow;
}

describe('TenantService.getPlatformDashboard — mapping', () => {
  it('zero-fills every lifecycle status and excludes the sentinel by id', async () => {
    const { service, countSpy } = makeService({
      counts: [
        { status: 'ACTIVE', count: 2 },
        { status: 'SUSPENDED', count: 1 },
      ],
      onboarding: [],
      invited: {},
      activity: [],
      names: new Map(),
    });
    const out = await service.getPlatformDashboard();
    const by = new Map(out.status_counts.map((c) => [c.status, c.count]));
    expect([...by.keys()].sort()).toEqual(
      ['ACTIVE', 'CLOSED', 'OFFBOARDING', 'PROVISIONED', 'SUSPENDED'].sort(),
    );
    expect(by.get('ACTIVE')).toBe(2);
    expect(by.get('SUSPENDED')).toBe(1);
    expect(by.get('PROVISIONED')).toBe(0);
    expect(by.get('OFFBOARDING')).toBe(0);
    expect(by.get('CLOSED')).toBe(0);
    // The sentinel is the id passed to the exclusion query.
    expect(countSpy).toHaveBeenCalledWith(PLATFORM_TENANT_SENTINEL_ID);
  });

  it('maps onboarding invited-state per tenant (order preserved from the repo)', async () => {
    const { service } = makeService({
      counts: [],
      onboarding: [
        { id: 't1', name: 'Oldest', created_at: '2026-01-01T00:00:00.000Z' },
        { id: 't2', name: 'Newer', created_at: '2026-02-01T00:00:00.000Z' },
      ],
      invited: { t1: true },
      activity: [],
      names: new Map(),
    });
    const out = await service.getPlatformDashboard();
    expect(out.onboarding).toEqual([
      {
        tenant_id: 't1',
        name: 'Oldest',
        created_at: '2026-01-01T00:00:00.000Z',
        invited: true,
      },
      {
        tenant_id: 't2',
        name: 'Newer',
        created_at: '2026-02-01T00:00:00.000Z',
        invited: false,
      },
    ]);
  });

  it('resolves tenant names and extracts reason codes from all payload shapes', async () => {
    const { service } = makeService({
      counts: [],
      onboarding: [],
      invited: {},
      activity: [
        row({
          tenant_id: 't1',
          event_type: 'tenant.suspended',
          event_payload: { reason: { code: 'ops_hold', text: 'x' } },
          created_at: new Date('2026-06-03T00:00:00.000Z'),
        }),
        row({
          tenant_id: 't2',
          event_type: 'tenant.owner_invite.sent',
          event_payload: { reason: 'resend' },
          created_at: new Date('2026-06-02T00:00:00.000Z'),
        }),
        row({
          tenant_id: 't3',
          event_type: 'tenant.activated',
          event_payload: { reason: { code: null, text: null } },
          created_at: new Date('2026-06-01T00:00:00.000Z'),
        }),
      ],
      names: new Map([
        ['t1', 'Alpha'],
        ['t2', 'Beta'],
        // t3 intentionally absent → tenant_name null (row gone).
      ]),
    });
    const out = await service.getPlatformDashboard();
    expect(out.recent_activity).toEqual([
      {
        event_type: 'tenant.suspended',
        tenant_id: 't1',
        tenant_name: 'Alpha',
        actor_type: 'user',
        reason_code: 'ops_hold',
        created_at: '2026-06-03T00:00:00.000Z',
      },
      {
        event_type: 'tenant.owner_invite.sent',
        tenant_id: 't2',
        tenant_name: 'Beta',
        actor_type: 'user',
        reason_code: 'resend',
        created_at: '2026-06-02T00:00:00.000Z',
      },
      {
        event_type: 'tenant.activated',
        tenant_id: 't3',
        tenant_name: null,
        actor_type: 'user',
        reason_code: null,
        created_at: '2026-06-01T00:00:00.000Z',
      },
    ]);
  });
});
