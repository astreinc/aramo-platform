import { Injectable } from '@nestjs/common';

import type { TalentDto } from './dto/talent.dto.js';
import type { TalentTenantOverlayDto } from './dto/talent-tenant-overlay.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

// Repository for Talent + TalentTenantOverlay reads/writes. CRUD-level
// only — no ingestion logic (M2 scope per PR-10 directive §4.3).
//
// The Talent core is tenant-agnostic (no tenant_id field — PR-10
// directive §4.1). All tenant association lives in TalentTenantOverlay.

export interface CreateTalentInput {
  // Optional: callers may pass a UUID v7 generated app-side (program
  // convention). When omitted, Prisma's @default(uuid()) fills it in.
  id?: string;
  lifecycle_status: string;
}

export interface CreateTalentTenantOverlayInput {
  id?: string;
  talent_id: string;
  tenant_id: string;
  source_recruiter_id?: string | null;
  source_channel: string;
  tenant_status: string;
}

@Injectable()
export class TalentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createTalent(input: CreateTalentInput): Promise<TalentDto> {
    const row = await this.prisma.talent.create({
      data: {
        ...(input.id !== undefined ? { id: input.id } : {}),
        lifecycle_status: input.lifecycle_status,
      },
    });
    return toTalentDto(row);
  }

  async createOverlay(
    input: CreateTalentTenantOverlayInput,
  ): Promise<TalentTenantOverlayDto> {
    const row = await this.prisma.talentTenantOverlay.create({
      data: {
        ...(input.id !== undefined ? { id: input.id } : {}),
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        source_recruiter_id: input.source_recruiter_id ?? null,
        source_channel: input.source_channel,
        tenant_status: input.tenant_status,
      },
    });
    return toOverlayDto(row);
  }

  async findTalentById(args: { id: string }): Promise<TalentDto | null> {
    const row = await this.prisma.talent.findUnique({
      where: { id: args.id },
    });
    if (row === null) {
      return null;
    }
    return toTalentDto(row);
  }

  async findOverlayByTenant(args: {
    talent_id: string;
    tenant_id: string;
  }): Promise<TalentTenantOverlayDto | null> {
    const row = await this.prisma.talentTenantOverlay.findUnique({
      where: {
        talent_id_tenant_id: {
          talent_id: args.talent_id,
          tenant_id: args.tenant_id,
        },
      },
    });
    if (row === null) {
      return null;
    }
    return toOverlayDto(row);
  }
}

type TalentRow = {
  id: string;
  lifecycle_status: string;
  created_at: Date;
  updated_at: Date;
};

function toTalentDto(row: TalentRow): TalentDto {
  return {
    id: row.id,
    lifecycle_status: row.lifecycle_status,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

type TalentTenantOverlayRow = {
  id: string;
  talent_id: string;
  tenant_id: string;
  source_recruiter_id: string | null;
  source_channel: string;
  tenant_status: string;
  created_at: Date;
  updated_at: Date;
};

function toOverlayDto(row: TalentTenantOverlayRow): TalentTenantOverlayDto {
  return {
    id: row.id,
    talent_id: row.talent_id,
    tenant_id: row.tenant_id,
    source_recruiter_id: row.source_recruiter_id,
    source_channel: row.source_channel,
    tenant_status: row.tenant_status,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
