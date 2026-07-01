import { Injectable } from '@nestjs/common';

import type { PortalProfileProjection } from './dto/portal-profile-projection.dto.js';
import { TalentRecordRepository } from './talent-record.repository.js';

// TalentRecordService — talent-record-side application surface.
//
// 4e-rest-b re-home: findSelfProfile moved here from libs/talent's
// TalentService. It reads the talent's OWN TalentRecord (the ATS heart),
// tenant-scoped, and projects the R10-filtered portal self-profile — replacing
// the old Core Talent+overlay reader. This removes the portal → libs/talent
// edge (the re-home is acyclic: talent-record does not import portal).
//
// The projection carries NO lifecycle_status (a Core `Talent` field with no
// TalentRecord equivalent); tenant_status is the profile's status field.
@Injectable()
export class TalentRecordService {
  constructor(
    private readonly talentRecordRepo: TalentRecordRepository,
  ) {}

  // findSelfProfile — the portal talent's own R10-filtered profile.
  //
  // NULLABILITY POLICY (4e-rest-b): tenant_status and source_channel are
  // nullable on TalentRecord. An un-statused record (either unset) has no
  // presentable self-profile → return null so the portal controller emits 404.
  // We do NOT loosen the contract to accept null (pact/openapi type both as
  // non-null strings), and we do NOT re-DDL TalentRecord nullability (4d owns
  // it). null is possible by construction — ATS-created / self-signup records
  // may carry an unset tenant_status until the tenant relationship is set — so
  // the guard is required, not defensive dead code.
  async findSelfProfile(input: {
    tenant_id: string;
    talent_id: string;
  }): Promise<PortalProfileProjection | null> {
    const row = await this.talentRecordRepo.findPortalProfileRow({
      tenant_id: input.tenant_id,
      id: input.talent_id,
    });
    if (row === null) return null;
    if (row.tenant_status === null || row.source_channel === null) return null;
    return {
      talent_id: row.id,
      tenant_id: row.tenant_id,
      tenant_status: row.tenant_status,
      source_channel: row.source_channel,
      created_at: row.created_at.toISOString(),
    };
  }
}
