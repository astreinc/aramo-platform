import { describe, expect, it, vi, beforeEach } from 'vitest';

import { TenantService } from '../lib/tenant.service.js';
import {
  TENANT_STATUSES,
  TENANT_TRANSITIONS,
  isLegalTransition,
  isTenantStatus,
  MINT_DENYING_STATUSES,
  type TenantStatus,
} from '../lib/util/tenant-lifecycle.js';

// Platform-Console Increment-2 PR-1 (workstream C tests) — the transition table
// (doc Part II §A), transition-service legality/idempotency/reason guardrails,
// and the mint-deny set. Pure unit tier (mocked repo + audit; no container).

describe('tenant lifecycle — state machine (doc Part II §A)', () => {
  it('has exactly the five states', () => {
    expect([...TENANT_STATUSES]).toEqual([
      'PROVISIONED',
      'ACTIVE',
      'SUSPENDED',
      'OFFBOARDING',
      'CLOSED',
    ]);
  });

  it('transition adjacency matches the doc table exactly', () => {
    expect(TENANT_TRANSITIONS).toEqual({
      PROVISIONED: ['ACTIVE', 'CLOSED'],
      ACTIVE: ['SUSPENDED', 'OFFBOARDING'],
      SUSPENDED: ['ACTIVE', 'OFFBOARDING'],
      OFFBOARDING: ['CLOSED'],
      CLOSED: [],
    });
  });

  it('rejects illegal transitions', () => {
    expect(isLegalTransition('ACTIVE', 'CLOSED')).toBe(false); // must go via OFFBOARDING
    expect(isLegalTransition('CLOSED', 'ACTIVE')).toBe(false); // terminal
    expect(isLegalTransition('PROVISIONED', 'SUSPENDED')).toBe(false);
    expect(isLegalTransition('OFFBOARDING', 'ACTIVE')).toBe(false);
  });

  it('the mint-deny set is exactly {SUSPENDED, CLOSED}', () => {
    expect([...MINT_DENYING_STATUSES].sort()).toEqual(['CLOSED', 'SUSPENDED']);
    for (const s of ['PROVISIONED', 'ACTIVE', 'OFFBOARDING'] as TenantStatus[]) {
      expect(MINT_DENYING_STATUSES.has(s)).toBe(false);
    }
  });

  it('isTenantStatus guards unknown strings', () => {
    expect(isTenantStatus('ACTIVE')).toBe(true);
    expect(isTenantStatus('ONBOARDING')).toBe(false);
  });
});

describe('TenantService.transitionTenantStatus (workstream C)', () => {
  let repo: {
    findLifecycleById: ReturnType<typeof vi.fn>;
    updateStatus: ReturnType<typeof vi.fn>;
  };
  let audit: { writeEvent: ReturnType<typeof vi.fn> };
  let svc: TenantService;
  const TID = '01900000-0000-7000-8000-0000000000aa';

  const make = (status: TenantStatus, is_active = true) => {
    repo = {
      findLifecycleById: vi.fn().mockResolvedValue({ id: TID, status, is_active }),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    };
    audit = { writeEvent: vi.fn().mockResolvedValue(undefined) };
    svc = new TenantService(repo as never, audit as never);
  };

  beforeEach(() => make('PROVISIONED'));

  it('activates PROVISIONED → ACTIVE (system), stamps activated_at, emits tenant.activated', async () => {
    const r = await svc.transitionTenantStatus({
      tenant_id: TID,
      to: 'ACTIVE',
      actor_id: 'sys',
      actor_type: 'system',
      source: 'invitation_acceptance',
    });
    expect(r).toEqual({ from: 'PROVISIONED', to: 'ACTIVE', changed: true });
    expect(repo.updateStatus).toHaveBeenCalledOnce();
    const patch = repo.updateStatus.mock.calls[0][1];
    expect(patch.status).toBe('ACTIVE');
    expect(patch.activated_at).toBeInstanceOf(Date);
    expect(patch.owner_accepted_at).toBeInstanceOf(Date);
    expect(audit.writeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'tenant.activated', actor_type: 'system' }),
    );
  });

  it('is an idempotent no-op when already in the target state (no write, no event)', async () => {
    make('ACTIVE');
    const r = await svc.transitionTenantStatus({
      tenant_id: TID,
      to: 'ACTIVE',
      actor_id: 'sys',
      actor_type: 'system',
      source: 'invitation_acceptance',
    });
    expect(r.changed).toBe(false);
    expect(repo.updateStatus).not.toHaveBeenCalled();
    expect(audit.writeEvent).not.toHaveBeenCalled();
  });

  it('rejects an illegal transition with 422 + emits tenant.lifecycle_transition_rejected', async () => {
    make('ACTIVE');
    await expect(
      svc.transitionTenantStatus({
        tenant_id: TID,
        to: 'CLOSED', // ACTIVE→CLOSED is illegal (must go via OFFBOARDING)
        actor_id: 'u',
        actor_type: 'user',
        source: 'platform_console',
        reason_code: 'x',
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(repo.updateStatus).not.toHaveBeenCalled();
    expect(audit.writeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'tenant.lifecycle_transition_rejected' }),
    );
  });

  it('SUSPEND requires reasonCode AND reasonText', async () => {
    make('ACTIVE');
    await expect(
      svc.transitionTenantStatus({
        tenant_id: TID,
        to: 'SUSPENDED',
        actor_id: 'u',
        actor_type: 'user',
        source: 'platform_console',
        reason_code: 'ABUSE',
        // reason_text missing
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    // with both present it succeeds and emits tenant.suspended
    await svc.transitionTenantStatus({
      tenant_id: TID,
      to: 'SUSPENDED',
      actor_id: 'u',
      actor_type: 'user',
      source: 'platform_console',
      reason_code: 'ABUSE',
      reason_text: 'ToS violation',
    });
    expect(audit.writeEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ event_type: 'tenant.suspended' }),
    );
  });

  it('SUSPENDED → ACTIVE emits tenant.reactivated (not tenant.activated) and requires reasonCode', async () => {
    make('SUSPENDED');
    await expect(
      svc.transitionTenantStatus({
        tenant_id: TID, to: 'ACTIVE', actor_id: 'u', actor_type: 'user', source: 'platform_console',
      }),
    ).rejects.toMatchObject({ statusCode: 422 }); // reasonCode required
    await svc.transitionTenantStatus({
      tenant_id: TID, to: 'ACTIVE', actor_id: 'u', actor_type: 'user', source: 'platform_console', reason_code: 'APPEAL_GRANTED',
    });
    expect(audit.writeEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ event_type: 'tenant.reactivated' }),
    );
  });

  it('OFFBOARDING requires retentionPolicyCode + closeAt', async () => {
    make('ACTIVE');
    await expect(
      svc.transitionTenantStatus({
        tenant_id: TID, to: 'OFFBOARDING', actor_id: 'u', actor_type: 'user', source: 'platform_console',
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await svc.transitionTenantStatus({
      tenant_id: TID, to: 'OFFBOARDING', actor_id: 'u', actor_type: 'user', source: 'platform_console',
      retention_policy_code: 'STANDARD_90D', close_at: new Date('2026-10-01T00:00:00Z'),
    });
    const patch = repo.updateStatus.mock.calls.at(-1)![1];
    expect(patch.offboarding_started_at).toBeInstanceOf(Date);
    expect(patch.retention_policy_code).toBe('STANDARD_90D');
    expect(patch.retention_delete_after).toBeInstanceOf(Date);
  });
});
