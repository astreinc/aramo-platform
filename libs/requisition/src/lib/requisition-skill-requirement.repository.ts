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

// SKILL-TAX-1F-B2 — one UNRESOLVED requirement surface form aggregated within the
// requisition domain, carrying its INTERNAL distinct tenant membership. The platform
// review queue (apps/api) unions this membership with the talent domain's to compute
// an exact, counts-only cross-domain tenant_count; the tenant ids NEVER leave the
// service. Raw raw_surface_form (never normalized here — the governance service
// applies the authoritative normalizer to merge across domains).
export interface UnresolvedRequirementSurfaceAggregate {
  surface_form: string;
  occurrence_count: number;
  tenant_ids: string[];
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

  // SKILL-TAX-1F-B2 — UNRESOLVED requirement-surface aggregates for the platform
  // review queue. GROUP BY the raw raw_surface_form; carry distinct tenant membership
  // for the governance service to union across domains (ids stay internal). Ordered
  // (occurrence_count DESC, surface_form ASC), hard-capped by scanLimit (caller logs a
  // truncating cap). Optional case-insensitive substring pre-filter. Domain-local raw
  // SQL against this schema only.
  async listUnresolvedSurfaceAggregates(args: {
    scanLimit: number;
    surfaceSearch?: string | null;
  }): Promise<UnresolvedRequirementSurfaceAggregate[]> {
    const search = args.surfaceSearch && args.surfaceSearch.trim().length > 0
      ? `%${args.surfaceSearch.trim()}%`
      : null;
    const rows = await this.prisma.$queryRaw<
      Array<{ surface_form: string; occurrence_count: number; tenant_ids: string[] }>
    >`
      SELECT
        raw_surface_form AS surface_form,
        COUNT(*)::int AS occurrence_count,
        array_agg(DISTINCT tenant_id::text) AS tenant_ids
      FROM requisition."RequisitionSkillRequirement"
      WHERE canonicalization_status = 'UNRESOLVED'
        AND (${search}::text IS NULL OR raw_surface_form ILIKE ${search}::text)
      GROUP BY raw_surface_form
      ORDER BY occurrence_count DESC, surface_form ASC
      LIMIT ${args.scanLimit}
    `;
    return rows.map((r) => ({
      surface_form: r.surface_form,
      occurrence_count: Number(r.occurrence_count),
      tenant_ids: r.tenant_ids,
    }));
  }

  // SKILL-TAX-1F-B1 — MERGE repoint on the requisition side. Every requirement row
  // still pointing at the loser canonical id moves to the winner. Idempotent (a
  // re-drain updates 0 rows); canonical ids are platform-global so this is
  // correctly cross-tenant. Raw raw_surface_form / version_requirement untouched.
  async repointCanonicalSkillId(fromCanonicalId: string, toCanonicalId: string): Promise<number> {
    const { count } = await this.prisma.requisitionSkillRequirement.updateMany({
      where: { canonical_skill_id: fromCanonicalId },
      data: { canonical_skill_id: toCanonicalId },
    });
    return count;
  }

  // SKILL-TAX-1F-B1 — targeted fan-out discovery: distinct golden profiles whose
  // requirements reference the affected canonical id(s) OR the corrected surface
  // form. Bounded by limit; never an unfiltered scan.
  async findAffectedGoldenProfiles(args: {
    canonicalSkillIds?: readonly string[];
    surfaceForms?: readonly string[];
    limit: number;
  }): Promise<Array<{ tenant_id: string; requisition_id: string; golden_profile_id: string }>> {
    const or: Array<Record<string, unknown>> = [];
    if (args.canonicalSkillIds && args.canonicalSkillIds.length > 0) {
      or.push({ canonical_skill_id: { in: [...args.canonicalSkillIds] } });
    }
    if (args.surfaceForms && args.surfaceForms.length > 0) {
      or.push({ raw_surface_form: { in: [...args.surfaceForms] } });
    }
    if (or.length === 0) return [];
    return this.prisma.requisitionSkillRequirement.findMany({
      where: { OR: or },
      select: { tenant_id: true, requisition_id: true, golden_profile_id: true },
      distinct: ['tenant_id', 'requisition_id', 'golden_profile_id'],
      orderBy: [{ tenant_id: 'asc' }, { requisition_id: 'asc' }, { golden_profile_id: 'asc' }],
      take: args.limit,
    });
  }
}
