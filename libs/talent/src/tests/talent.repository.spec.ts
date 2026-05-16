import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../lib/prisma/prisma.service.js';
import { TalentRepository } from '../lib/talent.repository.js';

const TALENT_ID = '01900000-0000-7000-8000-000000000010';
const TENANT_A = '01900000-0000-7000-8000-000000000001';
const RECRUITER_ID = '01900000-0000-7000-8000-000000000020';
const OVERLAY_ID = '01900000-0000-7000-8000-0000000000a0';

const TALENT_ROW = {
  id: TALENT_ID,
  lifecycle_status: 'active',
  created_at: new Date('2026-05-16T00:00:00Z'),
  updated_at: new Date('2026-05-16T00:00:00Z'),
};

const OVERLAY_ROW = {
  id: OVERLAY_ID,
  talent_id: TALENT_ID,
  tenant_id: TENANT_A,
  source_recruiter_id: RECRUITER_ID,
  source_channel: 'recruiter_capture',
  tenant_status: 'active',
  created_at: new Date('2026-05-16T00:00:00Z'),
  updated_at: new Date('2026-05-16T00:00:00Z'),
};

function makePrisma(overrides: {
  talent?: { create?: ReturnType<typeof vi.fn>; findUnique?: ReturnType<typeof vi.fn> };
  talentTenantOverlay?: {
    create?: ReturnType<typeof vi.fn>;
    findUnique?: ReturnType<typeof vi.fn>;
  };
}): PrismaService {
  return {
    talent: {
      create: overrides.talent?.create ?? vi.fn(),
      findUnique: overrides.talent?.findUnique ?? vi.fn(),
    },
    talentTenantOverlay: {
      create: overrides.talentTenantOverlay?.create ?? vi.fn(),
      findUnique: overrides.talentTenantOverlay?.findUnique ?? vi.fn(),
    },
  } as unknown as PrismaService;
}

describe('TalentRepository.createTalent', () => {
  it('issues prisma.talent.create with the supplied lifecycle_status and returns a TalentDto', async () => {
    const create = vi.fn().mockResolvedValue(TALENT_ROW);
    const repo = new TalentRepository(makePrisma({ talent: { create } }));

    const result = await repo.createTalent({ lifecycle_status: 'active' });

    expect(create).toHaveBeenCalledWith({
      data: { lifecycle_status: 'active' },
    });
    expect(result).toEqual({
      id: TALENT_ID,
      lifecycle_status: 'active',
      created_at: '2026-05-16T00:00:00.000Z',
      updated_at: '2026-05-16T00:00:00.000Z',
    });
  });

  it('passes through an explicit id when the caller supplies one (app-side UUID v7)', async () => {
    const create = vi.fn().mockResolvedValue(TALENT_ROW);
    const repo = new TalentRepository(makePrisma({ talent: { create } }));

    await repo.createTalent({ id: TALENT_ID, lifecycle_status: 'active' });

    expect(create).toHaveBeenCalledWith({
      data: { id: TALENT_ID, lifecycle_status: 'active' },
    });
  });

  it('does not pass tenant_id (Talent is tenant-agnostic by design)', async () => {
    const create = vi.fn().mockResolvedValue(TALENT_ROW);
    const repo = new TalentRepository(makePrisma({ talent: { create } }));

    await repo.createTalent({ lifecycle_status: 'active' });

    const calledWith = create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(calledWith.data).not.toHaveProperty('tenant_id');
  });
});

describe('TalentRepository.createOverlay', () => {
  it('issues prisma.talentTenantOverlay.create with the supplied fields and returns an overlay DTO', async () => {
    const create = vi.fn().mockResolvedValue(OVERLAY_ROW);
    const repo = new TalentRepository(makePrisma({ talentTenantOverlay: { create } }));

    const result = await repo.createOverlay({
      talent_id: TALENT_ID,
      tenant_id: TENANT_A,
      source_recruiter_id: RECRUITER_ID,
      source_channel: 'recruiter_capture',
      tenant_status: 'active',
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        talent_id: TALENT_ID,
        tenant_id: TENANT_A,
        source_recruiter_id: RECRUITER_ID,
        source_channel: 'recruiter_capture',
        tenant_status: 'active',
      },
    });
    expect(result.id).toBe(OVERLAY_ID);
    expect(result.talent_id).toBe(TALENT_ID);
    expect(result.tenant_id).toBe(TENANT_A);
    expect(typeof result.created_at).toBe('string');
    expect(typeof result.updated_at).toBe('string');
  });

  it('writes null when source_recruiter_id is omitted (self_signup case)', async () => {
    const create = vi.fn().mockResolvedValue({ ...OVERLAY_ROW, source_recruiter_id: null });
    const repo = new TalentRepository(makePrisma({ talentTenantOverlay: { create } }));

    await repo.createOverlay({
      talent_id: TALENT_ID,
      tenant_id: TENANT_A,
      source_channel: 'self_signup',
      tenant_status: 'active',
    });

    const calledWith = create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(calledWith.data['source_recruiter_id']).toBeNull();
  });
});

describe('TalentRepository.findTalentById', () => {
  it('queries prisma.talent.findUnique and maps the result to a TalentDto', async () => {
    const findUnique = vi.fn().mockResolvedValue(TALENT_ROW);
    const repo = new TalentRepository(makePrisma({ talent: { findUnique } }));

    const result = await repo.findTalentById({ id: TALENT_ID });

    expect(findUnique).toHaveBeenCalledWith({ where: { id: TALENT_ID } });
    expect(result?.id).toBe(TALENT_ID);
    expect(result?.lifecycle_status).toBe('active');
  });

  it('returns null when no row matches', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const repo = new TalentRepository(makePrisma({ talent: { findUnique } }));

    const result = await repo.findTalentById({ id: TALENT_ID });

    expect(result).toBeNull();
  });
});

describe('TalentRepository.findOverlayByTenant', () => {
  it('queries the composite unique key (talent_id, tenant_id) and returns the overlay DTO', async () => {
    const findUnique = vi.fn().mockResolvedValue(OVERLAY_ROW);
    const repo = new TalentRepository(makePrisma({ talentTenantOverlay: { findUnique } }));

    const result = await repo.findOverlayByTenant({
      talent_id: TALENT_ID,
      tenant_id: TENANT_A,
    });

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        talent_id_tenant_id: {
          talent_id: TALENT_ID,
          tenant_id: TENANT_A,
        },
      },
    });
    expect(result?.talent_id).toBe(TALENT_ID);
    expect(result?.tenant_id).toBe(TENANT_A);
  });

  it('returns null when no overlay exists for the (talent, tenant) pair', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const repo = new TalentRepository(makePrisma({ talentTenantOverlay: { findUnique } }));

    const result = await repo.findOverlayByTenant({
      talent_id: TALENT_ID,
      tenant_id: TENANT_A,
    });

    expect(result).toBeNull();
  });
});
