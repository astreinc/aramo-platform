import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AramoError, IDENTITY_MIGRATIONS } from '@aramo/common';
import { describe, expect, it } from 'vitest';

import { PLATFORM_LAST_OWNER_DB_MARKER, isPlatformLastOwnerViolation, isTenantLastOwnerViolation, rethrowTenantLastOwner } from '../lib/util/tenant-last-owner.js';

// CCP-A9 (T2-F1-H3 Amendment A1 A1-4) — the identity side of the last-effective-platform_owner
// invariant: the migration's shape (cloned from ROLES-1; splitter-safe; no bypass) and the
// mapping of its DB refusal to 409 PLATFORM_LAST_OWNER. The trigger behaviour itself is proven
// on real Postgres in libs/subscription ccp-a9-bootstrap-role-change.integration.spec.ts
// (A9-LO-1…3).

const MIGRATION = resolve(__dirname, '../../prisma/migrations/20261025180000_ccp_a9_platform_last_owner_invariant/migration.sql');

describe('CCP-A9 platform last-owner invariant (identity)', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const statements = sql
    .split('\n')
    .filter((l) => !l.startsWith('--') && l.trim().length > 0);

  it('A9-ID-1 covers role removal / re-point, membership deactivation / deletion / re-point and user deactivation, each ENABLE ALWAYS; no GUC, no skip flag', () => {
    for (const t of [
      'ccp_a9_platform_last_owner_role_delete',
      'ccp_a9_platform_last_owner_role_update',
      'ccp_a9_platform_last_owner_membership_delete',
      'ccp_a9_platform_last_owner_membership_update',
      'ccp_a9_platform_last_owner_user_update',
    ]) {
      expect(statements.filter((l) => l.startsWith('CREATE TRIGGER') && l.includes(`"${t}"`)), t).toHaveLength(1);
      expect(statements.filter((l) => l.includes(`ENABLE ALWAYS TRIGGER "${t}"`)), t).toHaveLength(1);
    }
    expect(sql).not.toMatch(/current_setting|set_config|session_replication_role\s*=/i);
    expect(sql).toContain(`pg_advisory_xact_lock(hashtext(''identity:platform_owner''))`);
  });

  it('A9-ID-0 registration — right after the CCP-A1 catalog migration, followed only by the CCP-A1 Amendment A1 Finance amount scope; stamps in apply order', () => {
    expect(IDENTITY_MIGRATIONS.slice(-3)).toEqual([
      'libs/identity/prisma/migrations/20261024120000_ccp_a1_commercial_role_catalog/migration.sql',
      'libs/identity/prisma/migrations/20261025180000_ccp_a9_platform_last_owner_invariant/migration.sql',
      'libs/identity/prisma/migrations/20261028060000_ccp_a1a1_finance_amount_scope/migration.sql',
    ]);
  });

  it('A9-ID-2 splitter-safe: every function body is a single-quoted one-line string (no dollar quoting, no double hyphen inside a body)', () => {
    expect(sql).not.toContain('$$');
    const fns = statements.filter((l) => l.startsWith('CREATE OR REPLACE FUNCTION'));
    expect(fns).toHaveLength(4);
    for (const f of fns) {
      expect(f.endsWith(`END';`)).toBe(true);
      expect(f.includes('--')).toBe(false);
    }
  });

  it('A9-ID-3 the DB refusal maps to 409 PLATFORM_LAST_OWNER; the tenant refusal keeps TENANT_LAST_OWNER; anything else is rethrown unchanged', () => {
    const platform = new Error(`${PLATFORM_LAST_OWNER_DB_MARKER}: the platform must keep at least one active platform_owner`);
    expect(isPlatformLastOwnerViolation(platform)).toBe(true);
    expect(isTenantLastOwnerViolation(platform)).toBe(false);
    let thrown: unknown;
    try {
      rethrowTenantLastOwner(platform, { operation: 'membership.deactivate', request_id: 'r' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AramoError);
    expect([(thrown as AramoError).code, (thrown as AramoError).statusCode, (thrown as AramoError).context.details]).toEqual([
      'PLATFORM_LAST_OWNER',
      409,
      { reason: 'platform_last_owner', operation: 'membership.deactivate' },
    ]);
    try {
      rethrowTenantLastOwner(new Error('tenant_last_owner: tenant x'), { operation: 'o' });
    } catch (e) {
      expect((e as AramoError).code).toBe('TENANT_LAST_OWNER');
    }
    const other = new Error('boom');
    expect(() => rethrowTenantLastOwner(other, { operation: 'o' })).toThrow(other);
  });
});
