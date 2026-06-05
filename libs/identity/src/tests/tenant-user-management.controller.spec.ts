import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';

import type { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
import type {
  DisableResult,
  InviteResult,
  TenantUserLifecycleService,
} from '../lib/tenant-user/tenant-user-lifecycle.service.js';
import { TenantUserManagementController } from '../lib/tenant-user/tenant-user-management.controller.js';

// Settings S3a — TenantUserManagementController unit proofs.
//
// The controller-boundary slice:
//   - body parsing: invite rejects empty/bad role_keys, missing email,
//     malformed body, NOT a list of strings; disable's optional reason
//     parses correctly + rejects non-string
//   - implicit-tenant pattern: tenant_id is taken from AuthContext, NEVER
//     from the body — even if the body smuggles a tenant_id field, the
//     saga is invoked with authContext.tenant_id
//   - the S2 app-layer two-call audit seam:
//       * disable changed=true → audit emitted with the disabled user_id
//         as subject_id + the authContext tenant_id
//       * disable changed=false (idempotent re-disable) → NO audit
//         (no-op-no-audit precedent)
//   - the invite path does NOT emit a controller-side audit (the
//     identity-tier events are emitted inside createUserFromInvitation)
//
// The decorator-driven guard chain (@UseGuards JwtAuthGuard +
// EntitlementGuard + RolesGuard + @RequireCapability + @RequireScopes) is
// structurally identical to D4aController and TenantSettingsController;
// guard-fire-403 is covered at the integration layer (the AppModule
// boot test exercises Nest's guard pipeline). Here the controller's
// own logic is the unit under test.

const REQUEST_ID = 'rq-s3a-ctl-001';
const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const OTHER_TENANT_ID = '01900000-0000-7000-8000-0000000000ee';
const ACTOR_ID = '01900000-0000-7000-8000-0000000000aa';
const USER_ID = '01900000-0000-7000-8000-0000000000bb';

function makeAuthContext(tenant_id = TENANT_ID, sub = ACTOR_ID): AuthContextType {
  return {
    sub,
    tenant_id,
    scopes: ['tenant:admin:user-manage'],
    consumer_type: 'tenant_user',
    capabilities: ['core'],
  } as unknown as AuthContextType;
}

interface Mocks {
  lifecycle: {
    inviteTenantUser: ReturnType<typeof vi.fn>;
    disableTenantUser: ReturnType<typeof vi.fn>;
    assignTenantUserRoles: ReturnType<typeof vi.fn>;
  };
  audit: { writeEvent: ReturnType<typeof vi.fn> };
  ctl: TenantUserManagementController;
}

function makeMocks(): Mocks {
  const lifecycle = {
    inviteTenantUser: vi.fn(),
    disableTenantUser: vi.fn(),
    assignTenantUserRoles: vi.fn(),
  };
  const audit = {
    writeEvent: vi.fn().mockResolvedValue(undefined),
  };
  const ctl = new TenantUserManagementController(
    lifecycle as unknown as TenantUserLifecycleService,
    audit as unknown as IdentityAuditService,
  );
  return { lifecycle, audit, ctl };
}

describe('TenantUserManagementController.invite — body parsing', () => {
  it('non-object body → VALIDATION_ERROR (missing_body)', async () => {
    const { ctl } = makeMocks();
    await expect(
      ctl.invite(makeAuthContext(), 'not-an-object', REQUEST_ID),
    ).rejects.toBeInstanceOf(AramoError);
    await expect(
      ctl.invite(makeAuthContext(), 'not-an-object', REQUEST_ID),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'missing_body' } },
    });
  });

  it('missing email → VALIDATION_ERROR (invalid_email)', async () => {
    const { ctl } = makeMocks();
    await expect(
      ctl.invite(makeAuthContext(), { role_keys: ['recruiter'] }, REQUEST_ID),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'invalid_email' } },
    });
  });

  it('empty role_keys → VALIDATION_ERROR (empty_role_keys) at controller boundary', async () => {
    const { ctl, lifecycle } = makeMocks();
    await expect(
      ctl.invite(
        makeAuthContext(),
        { email: 'x@y.com', role_keys: [] },
        REQUEST_ID,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'empty_role_keys' } },
    });
    expect(lifecycle.inviteTenantUser).not.toHaveBeenCalled();
  });

  it('role_keys with non-string item → VALIDATION_ERROR (invalid_role_key_item)', async () => {
    const { ctl } = makeMocks();
    await expect(
      ctl.invite(
        makeAuthContext(),
        { email: 'x@y.com', role_keys: ['recruiter', 42] },
        REQUEST_ID,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'invalid_role_key_item' } },
    });
  });
});

describe('TenantUserManagementController.invite — implicit-tenant pattern', () => {
  it('saga is called with authContext.tenant_id, NOT a body-supplied tenant_id', async () => {
    const { ctl, lifecycle } = makeMocks();
    lifecycle.inviteTenantUser.mockResolvedValue({
      user: { id: USER_ID, email: 'x@y.com' },
      membership_id: 'mem-1',
      cognito_sub: 'sub-1',
    } as unknown as InviteResult);
    // Hostile caller smuggles a tenant_id in the body.
    await ctl.invite(
      makeAuthContext(TENANT_ID),
      {
        email: 'x@y.com',
        role_keys: ['recruiter'],
        tenant_id: OTHER_TENANT_ID,
      },
      REQUEST_ID,
    );
    expect(lifecycle.inviteTenantUser).toHaveBeenCalledTimes(1);
    const args = lifecycle.inviteTenantUser.mock.calls[0]?.[0] as {
      tenant_id: string;
      actor_user_id: string;
    };
    expect(args.tenant_id).toBe(TENANT_ID);
    expect(args.tenant_id).not.toBe(OTHER_TENANT_ID);
    expect(args.actor_user_id).toBe(ACTOR_ID);
  });

  it('happy path response shape: {user_id, membership_id, cognito_sub}', async () => {
    const { ctl, lifecycle, audit } = makeMocks();
    lifecycle.inviteTenantUser.mockResolvedValue({
      user: { id: USER_ID, email: 'x@y.com' },
      membership_id: 'mem-1',
      cognito_sub: 'sub-1',
    } as unknown as InviteResult);
    const result = await ctl.invite(
      makeAuthContext(),
      { email: 'x@y.com', role_keys: ['recruiter'] },
      REQUEST_ID,
    );
    expect(result).toEqual({
      user_id: USER_ID,
      membership_id: 'mem-1',
      cognito_sub: 'sub-1',
    });
    // Invite path emits NO controller-side audit (the identity-tier
    // events are emitted inside createUserFromInvitation; no double-
    // emit here).
    expect(audit.writeEvent).not.toHaveBeenCalled();
  });
});

describe('TenantUserManagementController.disable — body parsing', () => {
  it('non-string reason → VALIDATION_ERROR', async () => {
    const { ctl } = makeMocks();
    await expect(
      ctl.disable(makeAuthContext(), USER_ID, { reason: 42 }, REQUEST_ID),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'invalid_reason' } },
    });
  });

  it('undefined body → reason=null forwarded to saga', async () => {
    const { ctl, lifecycle } = makeMocks();
    lifecycle.disableTenantUser.mockResolvedValue({
      membership_id: 'mem-1',
      changed: true,
      already_disabled: false,
    } as DisableResult);
    await ctl.disable(makeAuthContext(), USER_ID, undefined, REQUEST_ID);
    const args = lifecycle.disableTenantUser.mock.calls[0]?.[0] as {
      reason: string | null;
    };
    expect(args.reason).toBeNull();
  });
});

describe('TenantUserManagementController.disable — audit seam (S2 precedent)', () => {
  it('changed=true → emits identity.tenant_user.disabled with subject=user_id, tenant=authContext.tenant_id', async () => {
    const { ctl, lifecycle, audit } = makeMocks();
    lifecycle.disableTenantUser.mockResolvedValue({
      membership_id: 'mem-1',
      changed: true,
      already_disabled: false,
    } as DisableResult);
    await ctl.disable(
      makeAuthContext(),
      USER_ID,
      { reason: 'left company' },
      REQUEST_ID,
    );
    expect(audit.writeEvent).toHaveBeenCalledTimes(1);
    expect(audit.writeEvent).toHaveBeenCalledWith({
      event_type: 'identity.tenant_user.disabled',
      actor_type: 'user',
      actor_id: ACTOR_ID,
      tenant_id: TENANT_ID,
      subject_id: USER_ID,
      payload: { membership_id: 'mem-1', reason: 'left company' },
    });
  });

  it('changed=false (idempotent re-disable) → NO audit emission (S2 no-op-no-audit precedent)', async () => {
    const { ctl, lifecycle, audit } = makeMocks();
    lifecycle.disableTenantUser.mockResolvedValue({
      membership_id: 'mem-1',
      changed: false,
      already_disabled: true,
    } as DisableResult);
    const result = await ctl.disable(makeAuthContext(), USER_ID, {}, REQUEST_ID);
    expect(result).toEqual({
      membership_id: 'mem-1',
      changed: false,
      already_disabled: true,
    });
    expect(audit.writeEvent).not.toHaveBeenCalled();
  });

  it('saga is called with authContext.tenant_id, NOT body-supplied', async () => {
    const { ctl, lifecycle } = makeMocks();
    lifecycle.disableTenantUser.mockResolvedValue({
      membership_id: 'mem-1',
      changed: true,
      already_disabled: false,
    } as DisableResult);
    await ctl.disable(
      makeAuthContext(TENANT_ID),
      USER_ID,
      // hostile body
      { tenant_id: OTHER_TENANT_ID, reason: null },
      REQUEST_ID,
    );
    const args = lifecycle.disableTenantUser.mock.calls[0]?.[0] as {
      tenant_id: string;
      user_id: string;
    };
    expect(args.tenant_id).toBe(TENANT_ID);
    expect(args.user_id).toBe(USER_ID);
  });
});

// Settings S3b — PATCH /v1/tenant/users/:user_id/roles unit proofs.
//
// Body parsing, the per-event audit gating (BOTH events, ONE event, NEITHER
// event depending on the delta), and the implicit-tenant pattern.

describe('TenantUserManagementController.assignRoles — body parsing', () => {
  it('non-object body → VALIDATION_ERROR (missing_body)', async () => {
    const { ctl } = makeMocks();
    await expect(
      ctl.assignRoles(makeAuthContext(), USER_ID, null, REQUEST_ID),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'missing_body' } },
    });
  });

  it('empty role_keys → VALIDATION_ERROR (empty_role_keys); saga not called', async () => {
    const { ctl, lifecycle } = makeMocks();
    await expect(
      ctl.assignRoles(makeAuthContext(), USER_ID, { role_keys: [] }, REQUEST_ID),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'empty_role_keys' } },
    });
    expect(lifecycle.assignTenantUserRoles).not.toHaveBeenCalled();
  });

  it('role_keys with non-string item → VALIDATION_ERROR (invalid_role_key_item)', async () => {
    const { ctl } = makeMocks();
    await expect(
      ctl.assignRoles(
        makeAuthContext(),
        USER_ID,
        { role_keys: ['recruiter', 99] },
        REQUEST_ID,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'invalid_role_key_item' } },
    });
  });
});

describe('TenantUserManagementController.assignRoles — per-event audit gate', () => {
  it('adds AND removes → BOTH events emitted (role_assigned + role_removed) with full payloads', async () => {
    const { ctl, lifecycle, audit } = makeMocks();
    lifecycle.assignTenantUserRoles.mockResolvedValue({
      membership_id: 'mem-1',
      before_role_keys: ['recruiter', 'sourcer'],
      after_role_keys: ['account_manager', 'recruiter'],
      added_role_keys: ['account_manager'],
      removed_role_keys: ['sourcer'],
    });
    const result = await ctl.assignRoles(
      makeAuthContext(),
      USER_ID,
      { role_keys: ['account_manager', 'recruiter'] },
      REQUEST_ID,
    );
    expect(result.added_role_keys).toEqual(['account_manager']);
    expect(result.removed_role_keys).toEqual(['sourcer']);
    expect(audit.writeEvent).toHaveBeenCalledTimes(2);
    const eventTypes = audit.writeEvent.mock.calls
      .map((c) => (c[0] as { event_type: string }).event_type)
      .sort();
    expect(eventTypes).toEqual([
      'identity.tenant_user.role_assigned',
      'identity.tenant_user.role_removed',
    ]);
    // role_assigned event carries added_role_keys
    const assignedCall = audit.writeEvent.mock.calls.find(
      (c) =>
        (c[0] as { event_type: string }).event_type ===
        'identity.tenant_user.role_assigned',
    );
    expect(assignedCall?.[0]).toMatchObject({
      tenant_id: TENANT_ID,
      subject_id: USER_ID,
      actor_id: ACTOR_ID,
      payload: {
        membership_id: 'mem-1',
        added_role_keys: ['account_manager'],
        before_role_keys: ['recruiter', 'sourcer'],
        after_role_keys: ['account_manager', 'recruiter'],
      },
    });
    // role_removed event carries removed_role_keys
    const removedCall = audit.writeEvent.mock.calls.find(
      (c) =>
        (c[0] as { event_type: string }).event_type ===
        'identity.tenant_user.role_removed',
    );
    expect(removedCall?.[0]).toMatchObject({
      payload: {
        membership_id: 'mem-1',
        removed_role_keys: ['sourcer'],
      },
    });
  });

  it('only adds (no removes) → ONLY role_assigned emitted', async () => {
    const { ctl, lifecycle, audit } = makeMocks();
    lifecycle.assignTenantUserRoles.mockResolvedValue({
      membership_id: 'mem-1',
      before_role_keys: ['recruiter'],
      after_role_keys: ['account_manager', 'recruiter'],
      added_role_keys: ['account_manager'],
      removed_role_keys: [],
    });
    await ctl.assignRoles(
      makeAuthContext(),
      USER_ID,
      { role_keys: ['account_manager', 'recruiter'] },
      REQUEST_ID,
    );
    expect(audit.writeEvent).toHaveBeenCalledTimes(1);
    expect(audit.writeEvent.mock.calls[0]?.[0]).toMatchObject({
      event_type: 'identity.tenant_user.role_assigned',
    });
  });

  it('only removes (no adds) → ONLY role_removed emitted', async () => {
    const { ctl, lifecycle, audit } = makeMocks();
    lifecycle.assignTenantUserRoles.mockResolvedValue({
      membership_id: 'mem-1',
      before_role_keys: ['recruiter', 'sourcer'],
      after_role_keys: ['recruiter'],
      added_role_keys: [],
      removed_role_keys: ['sourcer'],
    });
    await ctl.assignRoles(
      makeAuthContext(),
      USER_ID,
      { role_keys: ['recruiter'] },
      REQUEST_ID,
    );
    expect(audit.writeEvent).toHaveBeenCalledTimes(1);
    expect(audit.writeEvent.mock.calls[0]?.[0]).toMatchObject({
      event_type: 'identity.tenant_user.role_removed',
    });
  });

  it('empty delta (no adds, no removes) → NEITHER event emitted (S2 no-op-no-audit, generalized)', async () => {
    const { ctl, lifecycle, audit } = makeMocks();
    lifecycle.assignTenantUserRoles.mockResolvedValue({
      membership_id: 'mem-1',
      before_role_keys: ['recruiter'],
      after_role_keys: ['recruiter'],
      added_role_keys: [],
      removed_role_keys: [],
    });
    await ctl.assignRoles(
      makeAuthContext(),
      USER_ID,
      { role_keys: ['recruiter'] },
      REQUEST_ID,
    );
    expect(audit.writeEvent).not.toHaveBeenCalled();
  });
});

describe('TenantUserManagementController.assignRoles — implicit-tenant', () => {
  it('saga called with authContext.tenant_id, NOT body-supplied', async () => {
    const { ctl, lifecycle } = makeMocks();
    lifecycle.assignTenantUserRoles.mockResolvedValue({
      membership_id: 'mem-1',
      before_role_keys: [],
      after_role_keys: ['recruiter'],
      added_role_keys: ['recruiter'],
      removed_role_keys: [],
    });
    await ctl.assignRoles(
      makeAuthContext(TENANT_ID),
      USER_ID,
      // hostile body smuggling a tenant_id
      { tenant_id: OTHER_TENANT_ID, role_keys: ['recruiter'] },
      REQUEST_ID,
    );
    const args = lifecycle.assignTenantUserRoles.mock.calls[0]?.[0] as {
      tenant_id: string;
      user_id: string;
      role_keys: readonly string[];
    };
    expect(args.tenant_id).toBe(TENANT_ID);
    expect(args.user_id).toBe(USER_ID);
    expect(args.role_keys).toEqual(['recruiter']);
  });
});
