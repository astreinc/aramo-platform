import { describe, expect, it, vi } from 'vitest';

import type { TalentDto } from '../lib/dto/talent.dto.js';
import type { TalentTenantOverlayDto } from '../lib/dto/talent-tenant-overlay.dto.js';
import {
  TalentRepository,
  type CreateTalentInput,
  type CreateTalentTenantOverlayInput,
} from '../lib/talent.repository.js';
import { TalentService } from '../lib/talent.service.js';

const TALENT_ID = '01900000-0000-7000-8000-000000000010';
const TENANT_A = '01900000-0000-7000-8000-000000000001';
const RECRUITER_ID = '01900000-0000-7000-8000-000000000020';
const OVERLAY_ID = '01900000-0000-7000-8000-0000000000a0';

function makeTalentDto(overrides: Partial<TalentDto> = {}): TalentDto {
  return {
    id: TALENT_ID,
    lifecycle_status: 'active',
    created_at: '2026-05-16T00:00:00.000Z',
    updated_at: '2026-05-16T00:00:00.000Z',
    ...overrides,
  };
}

function makeOverlayDto(
  overrides: Partial<TalentTenantOverlayDto> = {},
): TalentTenantOverlayDto {
  return {
    id: OVERLAY_ID,
    talent_id: TALENT_ID,
    tenant_id: TENANT_A,
    source_recruiter_id: RECRUITER_ID,
    source_channel: 'recruiter_capture',
    tenant_status: 'active',
    created_at: '2026-05-16T00:00:00.000Z',
    updated_at: '2026-05-16T00:00:00.000Z',
    ...overrides,
  };
}

function makeRepoMock(): TalentRepository {
  return {
    createTalent: vi.fn(),
    createOverlay: vi.fn(),
    findTalentById: vi.fn(),
    findOverlayByTenant: vi.fn(),
  } as unknown as TalentRepository;
}

describe('TalentService.createTalent', () => {
  it('delegates to repository.createTalent and returns the resulting TalentDto', async () => {
    const repo = makeRepoMock();
    const dto = makeTalentDto();
    (repo.createTalent as ReturnType<typeof vi.fn>).mockResolvedValue(dto);
    const service = new TalentService(repo);

    const input: CreateTalentInput = { lifecycle_status: 'active' };
    const result = await service.createTalent(input);

    expect(repo.createTalent).toHaveBeenCalledWith(input);
    expect(result).toEqual(dto);
  });
});

describe('TalentService.createOverlay', () => {
  it('delegates to repository.createOverlay and returns the resulting overlay DTO', async () => {
    const repo = makeRepoMock();
    const dto = makeOverlayDto();
    (repo.createOverlay as ReturnType<typeof vi.fn>).mockResolvedValue(dto);
    const service = new TalentService(repo);

    const input: CreateTalentTenantOverlayInput = {
      talent_id: TALENT_ID,
      tenant_id: TENANT_A,
      source_recruiter_id: RECRUITER_ID,
      source_channel: 'recruiter_capture',
      tenant_status: 'active',
    };
    const result = await service.createOverlay(input);

    expect(repo.createOverlay).toHaveBeenCalledWith(input);
    expect(result).toEqual(dto);
  });
});

describe('TalentService.getTalent', () => {
  it('returns the TalentDto when the repository finds the row', async () => {
    const repo = makeRepoMock();
    const dto = makeTalentDto();
    (repo.findTalentById as ReturnType<typeof vi.fn>).mockResolvedValue(dto);
    const service = new TalentService(repo);

    const result = await service.getTalent({ id: TALENT_ID });

    expect(repo.findTalentById).toHaveBeenCalledWith({ id: TALENT_ID });
    expect(result).toEqual(dto);
  });

  it('returns null when no Talent matches', async () => {
    const repo = makeRepoMock();
    (repo.findTalentById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const service = new TalentService(repo);

    const result = await service.getTalent({ id: TALENT_ID });

    expect(result).toBeNull();
  });

  it('returns a Talent shape with no tenant_id field (tenant-agnostic core)', async () => {
    const repo = makeRepoMock();
    const dto = makeTalentDto();
    (repo.findTalentById as ReturnType<typeof vi.fn>).mockResolvedValue(dto);
    const service = new TalentService(repo);

    const result = await service.getTalent({ id: TALENT_ID });

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('tenant_id');
    expect(Object.keys(result as Record<string, unknown>)).toEqual([
      'id',
      'lifecycle_status',
      'created_at',
      'updated_at',
    ]);
  });
});

describe('TalentService.getOverlayByTenant', () => {
  it('returns the overlay DTO when the repository finds a matching (talent, tenant) pair', async () => {
    const repo = makeRepoMock();
    const dto = makeOverlayDto();
    (repo.findOverlayByTenant as ReturnType<typeof vi.fn>).mockResolvedValue(dto);
    const service = new TalentService(repo);

    const result = await service.getOverlayByTenant({
      talent_id: TALENT_ID,
      tenant_id: TENANT_A,
    });

    expect(repo.findOverlayByTenant).toHaveBeenCalledWith({
      talent_id: TALENT_ID,
      tenant_id: TENANT_A,
    });
    expect(result).toEqual(dto);
  });

  it('returns null when no overlay exists for the (talent, tenant) pair', async () => {
    const repo = makeRepoMock();
    (repo.findOverlayByTenant as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const service = new TalentService(repo);

    const result = await service.getOverlayByTenant({
      talent_id: TALENT_ID,
      tenant_id: TENANT_A,
    });

    expect(result).toBeNull();
  });
});
