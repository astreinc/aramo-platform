import { describe, expect, it, vi } from 'vitest';

import { TalentRecordService } from '../lib/talent-record.service.js';

// 4e-rest-b — TalentRecordService.findSelfProfile (the re-homed portal
// self-profile reader). Reads the talent's own TalentRecord, tenant-scoped,
// and projects the R10-filtered portal profile. NO lifecycle_status (Core-only
// field dropped in the re-home). NULLABILITY POLICY: tenant_status /
// source_channel are nullable on TalentRecord; an un-statused record has no
// presentable self-profile → return null (the controller maps null → 404).

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const CREATED = new Date('2026-05-01T12:00:00.000Z');

function makeRepo(row: {
  id: string;
  tenant_id: string;
  tenant_status: string | null;
  source_channel: string | null;
  created_at: Date;
} | null) {
  return {
    findPortalProfileRow: vi.fn().mockResolvedValue(row),
  };
}

describe('TalentRecordService.findSelfProfile', () => {
  it('projects {talent_id, tenant_id, tenant_status, source_channel, created_at} — NO lifecycle_status', async () => {
    const repo = makeRepo({
      id: TALENT_ID,
      tenant_id: TENANT_ID,
      tenant_status: 'active',
      source_channel: 'self_signup',
      created_at: CREATED,
    });
    const svc = new TalentRecordService(repo as never);

    const out = await svc.findSelfProfile({ tenant_id: TENANT_ID, talent_id: TALENT_ID });

    expect(out).toEqual({
      talent_id: TALENT_ID,
      tenant_id: TENANT_ID,
      tenant_status: 'active',
      source_channel: 'self_signup',
      created_at: '2026-05-01T12:00:00.000Z',
    });
    expect(out).not.toHaveProperty('lifecycle_status');
    // Tenant-scoped read wired through.
    expect(repo.findPortalProfileRow).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      id: TALENT_ID,
    });
  });

  it('returns null when no TalentRecord exists in tenant (→ 404)', async () => {
    const svc = new TalentRecordService(makeRepo(null) as never);
    expect(
      await svc.findSelfProfile({ tenant_id: TENANT_ID, talent_id: TALENT_ID }),
    ).toBeNull();
  });

  it('NULLABILITY POLICY: null tenant_status → null (un-statused record has no presentable profile → 404)', async () => {
    const svc = new TalentRecordService(
      makeRepo({
        id: TALENT_ID,
        tenant_id: TENANT_ID,
        tenant_status: null,
        source_channel: 'self_signup',
        created_at: CREATED,
      }) as never,
    );
    expect(
      await svc.findSelfProfile({ tenant_id: TENANT_ID, talent_id: TALENT_ID }),
    ).toBeNull();
  });

  it('NULLABILITY POLICY: null source_channel → null (pact matches source_channel non-null → 404)', async () => {
    const svc = new TalentRecordService(
      makeRepo({
        id: TALENT_ID,
        tenant_id: TENANT_ID,
        tenant_status: 'active',
        source_channel: null,
        created_at: CREATED,
      }) as never,
    );
    expect(
      await svc.findSelfProfile({ tenant_id: TENANT_ID, talent_id: TALENT_ID }),
    ).toBeNull();
  });
});
