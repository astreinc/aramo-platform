import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  COMMERCIAL_GRANTED_SOURCES,
  GRANTED_SOURCES,
  UnknownCapabilityError,
  isCommercialGrantSource,
  revokeEntitlements,
  upsertEntitlements,
} from '../lib/entitlement-provenance.js';

// CCP-A7 — the provenance value list (doc/ccp/slices/CCP-A7-pre-execution.md §2) pinned to the
// migration CHECKs, and the fail-closed argument rules of the shared writer (no SQL runs).

const MIGRATION = readFileSync(
  resolve(__dirname, '../../prisma/migrations/20261026000000_ccp_a7_entitlement_revoke_provenance/migration.sql'),
  'utf8',
);
const checkList = (name: string): string[] => {
  const m = new RegExp(`"${name}"\\s*CHECK \\(\\(?"granted_source" IN \\(([^)]*)\\)`).exec(MIGRATION);
  if (m === null) throw new Error(`no CHECK ${name}`);
  return (m[1] as string).split(',').map((v) => v.trim().replace(/'/g, ''));
};

describe('CCP-A7 entitlement provenance', () => {
  it('A7-U-2 the code value list equals the DB CHECK; the Part IV values are kept verbatim (no rename) and PROVISIONING, SIGNUP are the only additions', () => {
    expect([...GRANTED_SOURCES]).toEqual(checkList('TenantEntitlement_granted_source_check'));
    expect([...COMMERCIAL_GRANTED_SOURCES]).toEqual(checkList('TenantEntitlement_commercial_source_check'));
    const partIv = ['MANUAL', 'PLAN', 'PROMOTION', 'MIGRATION'];
    expect(GRANTED_SOURCES.slice(0, 4)).toEqual(partIv);
    expect(GRANTED_SOURCES.filter((v) => !partIv.includes(v))).toEqual(['PROVISIONING', 'SIGNUP']);
    // CCP-R1 (TD-A7-3): the pre-A7 backfill is an explicit UPDATE to the non-commercial MIGRATION
    // value; the column is NOT NULL with NO default (no silent fallback to MIGRATION).
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS "granted_source" TEXT;/);
    expect(MIGRATION).toMatch(/UPDATE "entitlement"\."TenantEntitlement" SET "granted_source" = 'MIGRATION' WHERE "granted_source" IS NULL;/);
    expect(MIGRATION).toMatch(/ALTER COLUMN "granted_source" SET NOT NULL;/);
    expect(MIGRATION).toMatch(/ALTER COLUMN "granted_source" DROP DEFAULT;/);
    expect(MIGRATION).not.toMatch(/"granted_source" TEXT[^;\n]*DEFAULT/);
    expect(MIGRATION).not.toMatch(/SET DEFAULT/);
  });

  it('A7-U-3 Conv. C-20: only MANUAL, PLAN and PROMOTION are commercial; a signup or provisioning grant is never evidence of payment', () => {
    expect(GRANTED_SOURCES.filter(isCommercialGrantSource)).toEqual(['MANUAL', 'PLAN', 'PROMOTION']);
    expect(isCommercialGrantSource('SIGNUP')).toBe(false);
    expect(isCommercialGrantSource('PROVISIONING')).toBe(false);
  });

  it('A7-U-4 the writer fails closed before any SQL: a commercial source needs a change request, an ungoverned one must not carry one, capabilities must be known', async () => {
    const db = { $queryRawUnsafe: vi.fn() };
    const T = '0190a7a7-0000-7000-8000-0000000000a1';
    await expect(upsertEntitlements(db, { tenant_id: T, capabilities: ['sign'], granted_source: 'MANUAL' })).rejects.toThrow(/must carry a change request/);
    await expect(upsertEntitlements(db, { tenant_id: T, capabilities: ['sign'], granted_source: 'SIGNUP', change_request_id: T })).rejects.toThrow(/must not carry a change request/);
    await expect(upsertEntitlements(db, { tenant_id: T, capabilities: ['nope'], granted_source: 'SIGNUP' })).rejects.toBeInstanceOf(UnknownCapabilityError);
    await expect(upsertEntitlements(db, { tenant_id: T, capabilities: ['sign'], granted_source: 'PAYMENT' as never })).rejects.toThrow(/unknown granted_source/);
    await expect(revokeEntitlements(db, { tenant_id: T, capabilities: ['nope'], revoked_by: T, revoke_change_request_id: T })).rejects.toBeInstanceOf(UnknownCapabilityError);
    expect(await upsertEntitlements(db, { tenant_id: T, capabilities: [], granted_source: 'SIGNUP' })).toEqual({ granted: [], already_held: [], withheld_revoked: [] });
    expect(await revokeEntitlements(db, { tenant_id: T, capabilities: [], revoked_by: T, revoke_change_request_id: T })).toEqual([]);
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('A7-U-5 the grant UPDATE branch fires only for a revoked row AND a governed grant (the SQL resurrection guard)', async () => {
    const db = { $queryRawUnsafe: vi.fn(async () => [{ capability: 'sign', outcome: 'already_held' }]) };
    await upsertEntitlements(db, { tenant_id: '0190a7a7-0000-7000-8000-0000000000a1', capabilities: ['sign'], granted_source: 'SIGNUP' });
    const sql = String((db.$queryRawUnsafe.mock.calls[0] as unknown[])[0]);
    expect(sql).toContain('ON CONFLICT (tenant_id, capability) DO UPDATE');
    expect(sql).toContain('WHERE "TenantEntitlement".revoked_at IS NOT NULL AND EXCLUDED.change_request_id IS NOT NULL');
    expect(sql).not.toMatch(/skipDuplicates|DO NOTHING/);
  });
});
