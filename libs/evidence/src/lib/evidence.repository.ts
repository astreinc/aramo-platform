import { Injectable, Logger } from '@nestjs/common';

import type {
  CapabilitySummary,
  ContactSummary,
  MatchJustification,
  RecruiterContribution,
  TalentIdentity,
  TalentJobEvidencePackageView,
} from './dto/talent-job-evidence-package.view.js';
import { PrismaService } from './prisma/prisma.service.js';

// Repository for the TalentJobEvidencePackage model (M4 PR-1 §4.3).
//
// Surface scope (closed, READ-ONLY at PR-1):
//   - findById: read one package by id within a tenant.
//   - findByTenantAndSubmittal: read one package by submittal_record_id
//     within a tenant.
//   - findByTenantAndTalent: read all packages for (tenant, talent),
//     newest first by created_at.
//
// No write methods. The evidence-package builder PR introduces writes
// with full immutability + version-pinning guards. PR-6/PR-7 precedent:
// a Prisma write-path spy in the integration spec asserts zero
// invocations of create/update/upsert/delete/createMany/deleteMany.
//
// Belt-and-suspenders immutability:
//   - No write method on this surface (compile-time).
//   - Database BEFORE UPDATE trigger rejects analytical-field UPDATEs
//     (see libs/evidence/prisma/migrations/.../migration.sql).
//
// Tenant isolation (Architecture §7.2): every method takes tenant_id
// and scopes the query by it. A query that omits tenant_id is not
// expressible against this surface.
//
// Projection: JSONB columns deserialize through typed view casts at
// the boundary (PR-6 §4.2 precedent). The columns are stored opaquely;
// the cast is the read-side type assertion only.
//
// Observability (Ruling 8 / Plan v1.5 §M4 "observability per-PR
// standard from M4 onward"): minimum INFO-level structured logging
// with the canonical fields (tenant_id, evidence_package_id, talent_id,
// job_id, query latency). Full observability standardization (library
// choice, metrics, traces, dashboards) lands in its dedicated M4 PR.

interface TalentJobEvidencePackageRow {
  id: string;
  tenant_id: string;
  talent_id: string;
  job_id: string;
  examination_id: string;
  submittal_record_id: string | null;
  parent_package_id: string | null;
  talent_identity: unknown;
  contact_summary: unknown;
  capability_summary: unknown;
  match_justification: unknown;
  recruiter_contribution: unknown;
  engagement_event_refs: unknown;
  created_at: Date;
}

function projectView(row: TalentJobEvidencePackageRow): TalentJobEvidencePackageView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    talent_id: row.talent_id,
    job_id: row.job_id,
    examination_id: row.examination_id,
    submittal_record_id: row.submittal_record_id,
    parent_package_id: row.parent_package_id,
    talent_identity: row.talent_identity as TalentIdentity,
    contact_summary: row.contact_summary as ContactSummary,
    capability_summary: row.capability_summary as CapabilitySummary,
    match_justification: row.match_justification as MatchJustification,
    recruiter_contribution: row.recruiter_contribution as RecruiterContribution,
    engagement_event_refs: (row.engagement_event_refs ?? []) as string[],
    created_at: row.created_at,
  };
}

@Injectable()
export class EvidenceRepository {
  private readonly logger = new Logger(EvidenceRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async findById(input: {
    tenant_id: string;
    id: string;
  }): Promise<TalentJobEvidencePackageView | null> {
    const startedAt = Date.now();
    const row = await this.prisma.talentJobEvidencePackage.findFirst({
      where: { tenant_id: input.tenant_id, id: input.id },
    });
    const view = row === null ? null : projectView(row as TalentJobEvidencePackageRow);
    this.logger.log({
      event: 'evidence.findById',
      tenant_id: input.tenant_id,
      evidence_package_id: input.id,
      hit: view !== null,
      latency_ms: Date.now() - startedAt,
    });
    return view;
  }

  async findByTenantAndSubmittal(input: {
    tenant_id: string;
    submittal_record_id: string;
  }): Promise<TalentJobEvidencePackageView | null> {
    const startedAt = Date.now();
    const row = await this.prisma.talentJobEvidencePackage.findFirst({
      where: {
        tenant_id: input.tenant_id,
        submittal_record_id: input.submittal_record_id,
      },
    });
    const view = row === null ? null : projectView(row as TalentJobEvidencePackageRow);
    this.logger.log({
      event: 'evidence.findByTenantAndSubmittal',
      tenant_id: input.tenant_id,
      submittal_record_id: input.submittal_record_id,
      hit: view !== null,
      latency_ms: Date.now() - startedAt,
    });
    return view;
  }

  async findByTenantAndTalent(input: {
    tenant_id: string;
    talent_id: string;
  }): Promise<TalentJobEvidencePackageView[]> {
    const startedAt = Date.now();
    const rows = await this.prisma.talentJobEvidencePackage.findMany({
      where: { tenant_id: input.tenant_id, talent_id: input.talent_id },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
    const views = (rows as TalentJobEvidencePackageRow[]).map((r) => projectView(r));
    this.logger.log({
      event: 'evidence.findByTenantAndTalent',
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
      result_count: views.length,
      latency_ms: Date.now() - startedAt,
    });
    return views;
  }
}
