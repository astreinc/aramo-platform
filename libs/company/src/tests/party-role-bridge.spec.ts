import { describe, expect, it } from 'vitest';

import {
  legacyStatusToRelStatus,
  buildCreateRelationships,
  buildUpdateRelationshipUpserts,
} from '../lib/company.repository.js';
import type { CreateCompanyRequestDto } from '../lib/dto/create-company-request.dto.js';
import type { UpdateCompanyRequestDto } from '../lib/dto/update-company-request.dto.js';

// Company Party/Role (ADR-0032) — Slice A1 compatibility-bridge logic. These
// are the pure decision functions behind create()/update(); the DB-level
// composite-relation nested create/upsert + cascade + cross-tenant FK reject
// are verified separately against the live DB (runtime check).

const T = '000000aa-0000-4000-8000-0000000000aa';
const C = '000000cc-0000-4000-8000-0000000000cc';

describe('legacyStatusToRelStatus — legacy status → relationship status (R1)', () => {
  it('maps prospect|active|inactive to UPPERCASE; defaults omitted → ACTIVE', () => {
    expect(legacyStatusToRelStatus('prospect')).toBe('PROSPECT');
    expect(legacyStatusToRelStatus('active')).toBe('ACTIVE');
    expect(legacyStatusToRelStatus('inactive')).toBe('INACTIVE');
    expect(legacyStatusToRelStatus(undefined)).toBe('ACTIVE'); // column default
  });
  it('returns null for do_not_contact (NOT a lifecycle state — §5/R1)', () => {
    expect(legacyStatusToRelStatus('do_not_contact')).toBeNull();
  });
});

describe('buildCreateRelationships — A1 create bridge', () => {
  it('legacy create (no relationships[]) derives one CLIENT relationship from status', () => {
    const out = buildCreateRelationships({ name: 'Acme', status: 'prospect' } as CreateCompanyRequestDto);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'CLIENT', status: 'PROSPECT', effective_to: null });
    expect(out[0]?.effective_from).toBeInstanceOf(Date);
  });
  it('omitted status → CLIENT/ACTIVE (column default)', () => {
    const out = buildCreateRelationships({ name: 'Acme' } as CreateCompanyRequestDto);
    expect(out[0]).toMatchObject({ type: 'CLIENT', status: 'ACTIVE' });
  });
  it('REJECTS a do_not_contact legacy create (§5) — 400, no invented status', () => {
    expect(() =>
      buildCreateRelationships({ name: 'Acme', status: 'do_not_contact' } as CreateCompanyRequestDto),
    ).toThrowError(/do_not_contact/i);
  });
  it('explicit relationships[] pass through (multi-role); status defaults PROSPECT', () => {
    const out = buildCreateRelationships({
      name: 'Acme',
      status: 'do_not_contact', // ignored — explicit relationships win, no reject
      relationships: [{ type: 'CLIENT', status: 'ACTIVE' }, { type: 'VENDOR' }],
    } as CreateCompanyRequestDto);
    expect(out).toHaveLength(2);
    expect(out.map((r) => `${r.type}/${r.status}`).sort()).toEqual(['CLIENT/ACTIVE', 'VENDOR/PROSPECT']);
  });
});

describe('buildUpdateRelationshipUpserts — A1 update bridge', () => {
  it('legacy status PATCH → syncs the CLIENT relationship (upsert by tenant/company/type)', () => {
    const out = buildUpdateRelationshipUpserts({ status: 'inactive' } as UpdateCompanyRequestDto, T, C);
    expect(out).toHaveLength(1);
    expect(out[0]?.where.tenant_id_company_id_type).toEqual({ tenant_id: T, company_id: C, type: 'CLIENT' });
    expect(out[0]?.update.status).toBe('INACTIVE');
    expect(out[0]?.create).toMatchObject({ type: 'CLIENT', status: 'INACTIVE' });
  });
  it('do_not_contact status PATCH → NO relationship change (preserve; §5)', () => {
    expect(buildUpdateRelationshipUpserts({ status: 'do_not_contact' } as UpdateCompanyRequestDto, T, C)).toEqual([]);
  });
  it('no status / no relationships → empty (nothing to touch)', () => {
    expect(buildUpdateRelationshipUpserts({ name: 'x' } as UpdateCompanyRequestDto, T, C)).toEqual([]);
  });
  it('explicit relationships[] upsert; effective_* only set when provided (no episode reset on status-only)', () => {
    const out = buildUpdateRelationshipUpserts(
      { relationships: [{ type: 'VENDOR', status: 'ON_HOLD' }] } as UpdateCompanyRequestDto,
      T,
      C,
    );
    expect(out[0]?.where.tenant_id_company_id_type.type).toBe('VENDOR');
    expect(out[0]?.update.status).toBe('ON_HOLD');
    expect('effective_from' in (out[0]?.update ?? {})).toBe(false);
    expect('effective_to' in (out[0]?.update ?? {})).toBe(false);
  });
  it('explicit relationship reactivation sets effective_from when provided (reuses row via upsert where)', () => {
    const from = '2026-09-13T00:00:00.000Z';
    const out = buildUpdateRelationshipUpserts(
      { relationships: [{ type: 'VENDOR', status: 'ACTIVE', effective_from: from, effective_to: null }] } as UpdateCompanyRequestDto,
      T,
      C,
    );
    expect(out[0]?.update.effective_from).toBeInstanceOf(Date);
    expect(out[0]?.update.effective_to).toBeNull();
  });
});
