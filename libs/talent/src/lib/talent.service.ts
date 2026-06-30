import { Injectable } from '@nestjs/common';

import type { PortalProfileProjection } from './dto/portal-profile-projection.dto.js';
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
// M3 PR-9 §4.2 adds findSelfProfile — the portal talent's self-view
// projection. R10-filtered: returns only the per-tenant context fields
// the talent should see about themselves; excludes source_recruiter_id
// (recruiter-internal) and any examination/match data (not on the entity).
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

  // M3 PR-9 §4.2 — portal self-profile projection. Returns null when no
  // overlay exists for (talent_id, tenant_id) — i.e. the talent exists on
  // the program but not in this tenant's roster. PortalController maps
  // null to 404 NOT_FOUND (singleton resource, distinct from PR-8's
  // empty-list-on-no-active-req posture for list resources).
  //
  // Projection fields (R10-filtered):
  //   - talent_id, tenant_id: scope context
  //   - lifecycle_status: from Talent core
  //   - tenant_status, source_channel: from TalentTenantOverlay
  //   - created_at: overlay's join-tenant timestamp (the talent's own
  //     entry into this tenant; not the Talent core's first-seen)
  // EXCLUDES source_recruiter_id (recruiter-internal — R8/R10 risk),
  // any examination/match data, any updated_at (operational metadata not
  // in Phase 3 Profile group).
  async findSelfProfile(input: {
    tenant_id: string;
    talent_id: string;
  }): Promise<PortalProfileProjection | null> {
    const overlay = await this.talentRepo.findOverlayByTenant({
      talent_id: input.talent_id,
      tenant_id: input.tenant_id,
    });
    if (overlay === null) return null;
    const talent = await this.talentRepo.findTalentById({ id: input.talent_id });
    if (talent === null) return null;
    return {
      talent_id: talent.id,
      tenant_id: overlay.tenant_id,
      lifecycle_status: talent.lifecycle_status,
      tenant_status: overlay.tenant_status,
      source_channel: overlay.source_channel,
      created_at: overlay.created_at,
    };
  }
}
