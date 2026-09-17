import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';

// RequisitionSkillRequirementRepository — SKILL-TAX-1D persistence for the typed
// canonical requisition-skill seam. Owns the requisition-schema table and the
// (system-context) read of Requisition.golden_profile_id used by the
// re-runnable reconciliation worker. No canonicalization here (that is the
// service, via the skills-taxonomy engine); this layer is pure persistence.

export type RequirementType = 'required' | 'preferred' | 'critical';

export interface RequisitionSkillRequirementRow {
  id: string;
  tenant_id: string;
  requisition_id: string;
  golden_profile_id: string;
  requirement_type: RequirementType;
  raw_surface_form: string;
  version_requirement: string | null;
  canonical_skill_id: string | null;
  canonical_version_id: string | null;
  canonicalization_status: string | null;
  canonicalization_method: string | null;
  canonicalized_at: Date | null;
}

export interface CreateRequirementInput {
  tenant_id: string;
  requisition_id: string;
  golden_profile_id: string;
  requirement_type: RequirementType;
  raw_surface_form: string;
  version_requirement: string | null;
  canonical_skill_id: string | null;
  canonical_version_id: string | null;
  canonicalization_status: string | null;
  canonicalization_method: string | null;
  canonicalized_at: Date;
}

export interface CanonicalUpdateInput {
  canonical_skill_id: string | null;
  canonical_version_id: string | null;
  canonicalization_status: string | null;
  canonicalization_method: string | null;
  canonicalized_at: Date;
}

@Injectable()
export class RequisitionSkillRequirementRepository {
  constructor(private readonly prisma: PrismaService) {}

  // System-context read (worker has no actor): the profile a requisition points
  // at. Tenant-scoped. NULL when the requisition has no confirmed profile yet.
  async findGoldenProfileIdForRequisition(
    tenantId: string,
    requisitionId: string,
  ): Promise<string | null> {
    const row = await this.prisma.requisition.findFirst({
      where: { id: requisitionId, tenant_id: tenantId },
      select: { golden_profile_id: true },
    });
    return row?.golden_profile_id ?? null;
  }

  async listForGoldenProfile(
    tenantId: string,
    goldenProfileId: string,
  ): Promise<RequisitionSkillRequirementRow[]> {
    const rows = await this.prisma.requisitionSkillRequirement.findMany({
      where: { tenant_id: tenantId, golden_profile_id: goldenProfileId },
      orderBy: [{ requirement_type: 'asc' }, { raw_surface_form: 'asc' }],
    });
    return rows as RequisitionSkillRequirementRow[];
  }

  async create(input: CreateRequirementInput): Promise<RequisitionSkillRequirementRow> {
    const created = await this.prisma.requisitionSkillRequirement.create({
      data: { id: uuidv7(), ...input },
    });
    return created as RequisitionSkillRequirementRow;
  }

  async updateCanonical(id: string, fields: CanonicalUpdateInput): Promise<void> {
    await this.prisma.requisitionSkillRequirement.update({
      where: { id },
      data: {
        canonical_skill_id: fields.canonical_skill_id,
        canonical_version_id: fields.canonical_version_id,
        canonicalization_status: fields.canonicalization_status,
        canonicalization_method: fields.canonicalization_method,
        canonicalized_at: fields.canonicalized_at,
      },
    });
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.requisitionSkillRequirement.delete({ where: { id } });
  }

  // SKILL-TAX Canonical Reconciliation Activation — coverage telemetry (read-only
  // aggregate, no new table). eligible = all derived rows.
  async coverage(): Promise<{ total: number; resolved: number; unresolved: number }> {
    const [total, resolved, unresolved] = await Promise.all([
      this.prisma.requisitionSkillRequirement.count(),
      this.prisma.requisitionSkillRequirement.count({
        where: { canonicalization_status: 'RESOLVED' },
      }),
      this.prisma.requisitionSkillRequirement.count({
        where: { canonicalization_status: 'UNRESOLVED' },
      }),
    ]);
    return { total, resolved, unresolved };
  }
}
