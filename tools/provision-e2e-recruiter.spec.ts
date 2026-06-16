import { describe, expect, it, vi } from 'vitest';

import {
  assertNonProd,
  parseArgs,
  provisionRecruiter,
  SYSTEM_ACTOR_ID,
  type IdentityLookupPort,
  type LifecyclePort,
} from './provision-e2e-recruiter.lib';

describe('assertNonProd (mandatory safety guard)', () => {
  const localDb = 'postgresql://u:p@localhost:5432/aramo';

  it('allows a local, non-prod target', () => {
    expect(() =>
      assertNonProd({ ARAMO_ENV: 'local', DATABASE_URL: localDb }),
    ).not.toThrow();
  });

  it('refuses a prod-like ARAMO_ENV', () => {
    for (const env of ['production', 'prod', 'staging', 'Stage']) {
      expect(() => assertNonProd({ ARAMO_ENV: env, DATABASE_URL: localDb })).toThrow(
        /prod-like|refusing/i,
      );
    }
  });

  it('refuses a non-local DATABASE_URL host (e.g. RDS)', () => {
    expect(() =>
      assertNonProd({
        ARAMO_ENV: 'local',
        DATABASE_URL: 'postgresql://u:p@aramo-prod.abc123.us-east-1.rds.amazonaws.com:5432/aramo',
      }),
    ).toThrow(/not local|refusing/i);
  });

  it('refuses when ARAMO_ENV or DATABASE_URL is missing (cannot confirm)', () => {
    expect(() => assertNonProd({ DATABASE_URL: localDb })).toThrow(/ARAMO_ENV/);
    expect(() => assertNonProd({ ARAMO_ENV: 'local' })).toThrow(/DATABASE_URL/);
  });
});

describe('parseArgs', () => {
  it('requires --email and --tenant; defaults role to recruiter', () => {
    expect(() => parseArgs(['--email', 'x@y.test'])).toThrow(/--tenant/);
    expect(() => parseArgs(['--tenant', 't-1'])).toThrow(/--email/);
    const parsed = parseArgs(['--email', 'x@y.test', '--tenant', 't-1']);
    expect(parsed).toEqual({
      email: 'x@y.test',
      tenant: 't-1',
      role: 'recruiter',
      actorUserId: SYSTEM_ACTOR_ID,
    });
  });
});

describe('provisionRecruiter', () => {
  it('calls the REAL invite saga with the right args when the user is new', async () => {
    const inviteTenantUser = vi.fn().mockResolvedValue({
      user: { id: 'user-1' },
      membership_id: 'mem-1',
      cognito_sub: 'sub-xyz',
    });
    const lifecycle: LifecyclePort = { inviteTenantUser };
    const identity: IdentityLookupPort = { findUserByEmail: vi.fn().mockResolvedValue(null) };

    const result = await provisionRecruiter(
      { lifecycle, identity },
      {
        email: 'recruiter-e2e@astreinc.test',
        tenantId: 'tenant-9',
        role: 'recruiter',
        actorUserId: SYSTEM_ACTOR_ID,
        requestId: 'req-1',
      },
    );

    expect(inviteTenantUser).toHaveBeenCalledWith({
      tenant_id: 'tenant-9',
      email: 'recruiter-e2e@astreinc.test',
      display_name: null,
      role_keys: ['recruiter'],
      actor_user_id: SYSTEM_ACTOR_ID,
      request_id: 'req-1',
    });
    expect(result).toEqual({
      status: 'created',
      user_id: 'user-1',
      membership_id: 'mem-1',
      cognito_sub: 'sub-xyz',
      tenant_id: 'tenant-9',
    });
  });

  it('is idempotent — an existing user is reported and NOT re-invited', async () => {
    const inviteTenantUser = vi.fn();
    const lifecycle: LifecyclePort = { inviteTenantUser };
    const identity: IdentityLookupPort = {
      findUserByEmail: vi.fn().mockResolvedValue({ id: 'existing-user' }),
    };

    const result = await provisionRecruiter(
      { lifecycle, identity },
      {
        email: 'recruiter-e2e@astreinc.test',
        tenantId: 'tenant-9',
        role: 'recruiter',
        actorUserId: SYSTEM_ACTOR_ID,
        requestId: 'req-1',
      },
    );

    expect(inviteTenantUser).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'already_exists',
      user_id: 'existing-user',
      tenant_id: 'tenant-9',
    });
  });
});
