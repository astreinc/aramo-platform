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
  // Settings D4: +3 site.created + site.updated + site.deactivated (27 -> 30).
  // Domain-Enforcement P2b: +2 domain.verification.requested + domain.verified (30 -> 32).
  // IC-1 PR-1: +1 invitation.rejected_cross_tenant (41 -> 42).
  // IC-3 PR-7: +1 tenant_user.enabled (42 -> 43).
  // DOC-TEMPLATE-ADMIN-RTR-1 A1 §1: +1 document_template.draft_discarded (43 -> 44).
  // ROLES-1 PR-2 §5.3: +2 ROLES1_RECONCILE_GRANT + ROLES1_RECONCILE_REVOKE (44 -> 46).
  // DOC-TEMPLATE-LIB-1 T-6: +2 GLOBAL document_template.withdrawal_published/_cancelled (46 -> 48).
  it('EVENT_TYPES contains 69 values (32 + 9 PC-Inc2 tenant-lifecycle + 1 IC-1 cross-tenant refusal + 1 IC-3 PR-7 enable + 1 A1 template draft discard + 2 ROLES-1 reconciliation + 2 T-6 withdrawal + 9 Domain-Enforcement P3 claim/exception/delegation + 12 Sign Personal signup/risk/invite/send-location/unverified-purge) and rejects unlisted', async () => {
    expect(EVENT_TYPES).toHaveLength(69);
    expect(TENANT_SCOPED_EVENT_TYPES.has('identity.domain.claim.authoritative')).toBe(true);
    expect(TENANT_SCOPED_EVENT_TYPES.has('ROLES1_RECONCILE_GRANT')).toBe(true);
    expect(TENANT_SCOPED_EVENT_TYPES.has('ROLES1_RECONCILE_REVOKE')).toBe(true);
    // T-6 — Aramo default withdrawal events are GLOBAL (a PLATFORM template has no tenant).
    expect(TENANT_SCOPED_EVENT_TYPES.has('identity.document_template.withdrawal_published')).toBe(false);
    expect(TENANT_SCOPED_EVENT_TYPES.has('identity.document_template.withdrawal_cancelled')).toBe(false);
    expect(TENANT_SCOPED_EVENT_TYPES.has('identity.document_template.draft_discarded')).toBe(true);
    expect(TENANT_SCOPED_EVENT_TYPES.has('identity.tenant_user.enabled')).toBe(true);
    expect(TENANT_SCOPED_EVENT_TYPES.has('identity.invitation.rejected_cross_tenant')).toBe(true);
    // Sign Personal (Free) v1.1 — risk events are tenant-scoped; the pilot invite issue is GLOBAL.
    expect(TENANT_SCOPED_EVENT_TYPES.has('identity.personal.risk.restricted')).toBe(true);
    expect(TENANT_SCOPED_EVENT_TYPES.has('identity.personal.invite.issued')).toBe(false);
    // The unverified-signup purge is GLOBAL too (no tenant exists for those requests).
    expect(TENANT_SCOPED_EVENT_TYPES.has('identity.personal.signup.unverified_purged')).toBe(false);
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
  // Settings D4 adds site.created + site.updated + site.deactivated (22 -> 25).
  // Domain-Enforcement P2b adds domain.verification.requested + domain.verified (25 -> 27).
  // IC-3 PR-7 adds tenant_user.enabled (27 -> 28).
  it('TENANT_SCOPED_EVENT_TYPES contains all the tenant-scoped values', () => {
    const expected = [
      'identity.tenant.created',
      'identity.membership.created',
      'identity.session.issued',
      'identity.session.refreshed',
      'identity.session.revoked',
      'identity.session.reuse_detected',
      'identity.invitation.created',
      'identity.invitation.accepted',
      // IC-1 PR-1 — cross-tenant invitation refusal (scoped to the target tenant).
      'identity.invitation.rejected_cross_tenant',
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
      // IC-3 PR-7 — tenant-user lifecycle ENABLE event (identity + IdP confirmed).
      'identity.tenant_user.enabled',
      // Settings S3b — tenant-user role-assign events (per-delta gating).
      'identity.tenant_user.role_assigned',
      'identity.tenant_user.role_removed',
      // Settings D3 — tenant-profile update event.
      'identity.tenant_profile.updated',
      // Settings D4 — sites/branches CRUD events.
      'identity.site.created',
      'identity.site.updated',
      'identity.site.deactivated',
      // Domain-Enforcement P2b — DNS-TXT verification events.
      'identity.domain.verification.requested',
      'identity.domain.verified',
      // Platform-Console Increment-2 PR-1 — 9 tenant-lifecycle events.
      'tenant.provisioned',
      'tenant.owner_invite.sent',
      'tenant.owner_invite.accepted',
      'tenant.activated',
      'tenant.suspended',
      'tenant.reactivated',
      'tenant.offboarding_started',
      'tenant.closed',
      'tenant.lifecycle_transition_rejected',
      // DOC-TEMPLATE-ADMIN-RTR-1 A1 §1 — template draft discard audit.
      'identity.document_template.draft_discarded',
      // ROLES-1 PR-2 §5.3 — the reconciliation migration's grant / removal rows.
      'ROLES1_RECONCILE_GRANT',
      'ROLES1_RECONCILE_REVOKE',
      // Sign Personal (Free) v1.1 — signup + risk-state events.
      'identity.personal.signup.provisioned',
      'identity.personal.signup.lapsed',
      'identity.personal.risk.review_flagged',
      'identity.personal.risk.step_up_required',
      'identity.personal.risk.phone_verified',
      'identity.personal.risk.restricted',
      'identity.personal.risk.review_cleared',
      'identity.personal.risk.reinstated',
      'identity.personal.risk.closed',
      'identity.personal.risk.send_location_signal',
    ];
    expect(TENANT_SCOPED_EVENT_TYPES.size).toBe(60); // IC-3 PR-7 +1 tenant_user.enabled; A1 +1 draft_discarded; ROLES-1 PR-2 +2; P3 +9; Personal +10
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
