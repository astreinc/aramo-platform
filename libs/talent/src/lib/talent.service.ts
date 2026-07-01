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
// The Talent core has no tenant_id, but post-realignment (ADR-0016) it is a
// per-tenant identity husk demoted from the former Core SOR (the ATS
// TalentRecord is the system of record; pending retirement, step 4e).
// Tenant association lives in TalentTenantOverlay; overlay reads are scoped
// by (talent_id, tenant_id).
//
// 4e-rest-b: the portal self-profile reader (findSelfProfile) was RE-HOMED
// off this Core reader onto TalentRecordService (libs/talent-record, the ATS
// heart), removing the portal → libs/talent edge. This service now carries
// only the Core CRUD used by the canonicalization mint (TR-2-deferred).
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
