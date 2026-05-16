import { Injectable } from '@nestjs/common';

import type { TalentDto } from './dto/talent.dto.js';
import type { TalentTenantOverlayDto } from './dto/talent-tenant-overlay.dto.js';
import {
  type CreateTalentInput,
  type CreateTalentTenantOverlayInput,
  TalentRepository,
} from './talent.repository.js';

// TalentService — CRUD-level operations for Talent + TalentTenantOverlay.
// PR-10 establishes the data model; ingestion logic is M2 scope.
//
// The Talent core is tenant-agnostic. Tenant association lives in
// TalentTenantOverlay; overlay reads are scoped by (talent_id, tenant_id).
@Injectable()
export class TalentService {
  constructor(private readonly talentRepo: TalentRepository) {}

  async createTalent(input: CreateTalentInput): Promise<TalentDto> {
    return this.talentRepo.createTalent(input);
  }

  async createOverlay(
    input: CreateTalentTenantOverlayInput,
  ): Promise<TalentTenantOverlayDto> {
    return this.talentRepo.createOverlay(input);
  }

  async getTalent(args: { id: string }): Promise<TalentDto | null> {
    return this.talentRepo.findTalentById(args);
  }

  async getOverlayByTenant(args: {
    talent_id: string;
    tenant_id: string;
  }): Promise<TalentTenantOverlayDto | null> {
    return this.talentRepo.findOverlayByTenant(args);
  }
}
