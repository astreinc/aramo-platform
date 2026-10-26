import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { AramoError } from '@aramo/common';
import { PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import { PLATFORM_ROLE_KEYS, SEED_ROLE_KEYS } from '@aramo/identity';
import { BOOTSTRAP_PLATFORM_TENANT_ID, COMMERCIAL_ROLE_CHANGE_ROLE_KEYS, CommercialChangeRequestError } from '@aramo/subscription';

import { toAramoError } from '../app/platform/platform-commercial-change-request.controller.js';
import { InvitePlatformAdminRequestDto } from '../app/platform/dto/invite-user.request.dto.js';

// CCP-A9 (PBD §5.1 row A9) — pins and boundaries that need both libs/identity / libs/auth and
// libs/subscription (which imports neither: no nx edge), the invite DTO's platform role keys,
// the error mapping of the two new service refusals, and the seed-file boundary of the D7
// bootstrap (T2-F1-H3 Amendment A1 A1-2(1)).

const REPO_ROOT = resolve(__dirname, '../../../..');
const H = 'a'.repeat(64);

describe('CCP-A9 pins (no identity/auth import in libs/subscription)', () => {
  it('A9-PIN-1 the grantable role-change keys are exactly PLATFORM_ROLE_KEYS minus super_admin (the 6 CCP roles)', () => {
    expect([...COMMERCIAL_ROLE_CHANGE_ROLE_KEYS].sort()).toEqual(PLATFORM_ROLE_KEYS.filter((k) => k !== 'super_admin').sort());
    expect(COMMERCIAL_ROLE_CHANGE_ROLE_KEYS as readonly string[]).not.toContain('super_admin');
  });

  it('A9-PIN-2 the bootstrap sentinel tenant is PLATFORM_TENANT_SENTINEL_ID', () => {
    expect(BOOTSTRAP_PLATFORM_TENANT_ID).toBe(PLATFORM_TENANT_SENTINEL_ID);
  });
});

describe('CCP-A9 platform-admin invite DTO accepts PLATFORM_ROLE_KEYS', () => {
  const errors = (body: Record<string, unknown>): string[] =>
    validateSync(plainToInstance(InvitePlatformAdminRequestDto, body), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);

  it.each(PLATFORM_ROLE_KEYS.map((k) => [k]))('A9-DTO-1 %s is accepted', (k) => {
    expect(errors({ email: 'a@aramo.ai', role_keys: [k], human_ref_hash: H })).toEqual([]);
  });

  it('A9-DTO-2 role_keys and human_ref_hash are optional (pre-A9 body still valid); a tenant role, an empty or duplicate list, or a malformed human reference is refused', () => {
    expect(errors({ email: 'a@aramo.ai' })).toEqual([]);
    const tenantRole = SEED_ROLE_KEYS.find((k) => !(PLATFORM_ROLE_KEYS as readonly string[]).includes(k)) as string;
    expect(errors({ email: 'a@aramo.ai', role_keys: [tenantRole] })).toEqual(['role_keys']);
    expect(errors({ email: 'a@aramo.ai', role_keys: [] })).toEqual(['role_keys']);
    expect(errors({ email: 'a@aramo.ai', role_keys: ['finance_admin', 'finance_admin'] })).toEqual(['role_keys']);
    expect(errors({ email: 'a@aramo.ai', role_keys: ['finance_admin'], human_ref_hash: 'A'.repeat(64) })).toEqual(['human_ref_hash']);
  });
});

describe('CCP-A9 error mapping', () => {
  it('A9-MAP-1 REQUESTER_ROLE_MISSING → 403 INSUFFICIENT_PERMISSIONS requester_role_missing; LAST_OWNER → 409 PLATFORM_LAST_OWNER', () => {
    const a = toAramoError(new CommercialChangeRequestError('REQUESTER_ROLE_MISSING', 'm', { required_role: 'platform_owner' }), 'req-1') as AramoError;
    expect(a).toBeInstanceOf(AramoError);
    expect([a.code, a.statusCode, a.context.details]).toEqual(['INSUFFICIENT_PERMISSIONS', 403, { reason: 'requester_role_missing', required_role: 'platform_owner' }]);
    const b = toAramoError(new CommercialChangeRequestError('LAST_OWNER', 'm', { reason: 'platform_last_owner' }), 'req-1') as AramoError;
    expect([b.code, b.statusCode, b.context.details]).toEqual(['PLATFORM_LAST_OWNER', 409, { reason: 'platform_last_owner' }]);
  });
});

describe('CCP-A9 bootstrap boundary (T2-F1-H3 Amendment A1 A1-2(1), A1-0)', () => {
  it('A9-SEED-1 no protected seed file and not deploy/seed-prod.sh references the bootstrap command; the seed-prod :28 assertion stays on the super_admin role id', () => {
    for (const f of ['libs/identity/prisma/seed.ts', 'libs/identity/prisma/seed-platform-owner.ts', 'libs/identity/prisma/seed-astre.ts', 'deploy/seed-prod.sh']) {
      const text = readFileSync(resolve(REPO_ROOT, f), 'utf8');
      for (const needle of ['ccp-bootstrap', 'ccp:bootstrap', 'runPlatformOwnerBootstrap', 'commercial-platform-owner-bootstrap', 'CommercialOperatorAttestation']) {
        expect(text.includes(needle), `${f} ∌ ${needle}`).toBe(false);
      }
    }
    // The :28 assertion stays filtered on the super_admin role id (A1-1).
    expect(readFileSync(resolve(REPO_ROOT, 'deploy/seed-prod.sh'), 'utf8')).toContain("mr.role_id='01900000-0000-7000-8000-00000000001d'");
  });
});
