import { Inject, Injectable } from '@nestjs/common';
import { RequisitionPrismaService } from '@aramo/requisition';
import {
  JobDomainRepository,
  goldenProfileContentFromStorage,
} from '@aramo/job-domain';

import type { RequisitionAnalysisSource } from '../dto/requisition-analysis-context.js';

import type { RequisitionAnalysisContextReader } from './requisition-analysis-context-reader.js';

// The exact allowlisted Requisition row this reader selects. Declaring
// it locally (rather than depending on the requisition module's
// generated Prisma model types across the dist boundary) keeps the
// gated compensation / financial columns structurally OUT of reach — the
// type itself cannot name them.
interface RequisitionAllowlistRow {
  id: string;
  tenant_id: string;
  version: number;
  golden_profile_id: string | null;
  title: string;
  job_type: string | null;
  labor_category: string | null;
  role_family: string | null;
  seniority_level: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  work_arrangement: string | null;
  onsite_days_per_week: number | null;
  travel_percent: number | null;
  relocation_offered: boolean;
  duration_value: number | null;
  duration_unit: string | null;
  hours_per_week: number | null;
  extension_possible: boolean;
  work_authorization: string | null;
}

// A narrow structural view over the requisition module's PrismaService —
// only the single tenant-scoped, allowlisted read this reader performs.
// Injected by the RequisitionPrismaService token (below) but typed to
// this minimal surface.
interface RequisitionReadClient {
  requisition: {
    findFirst(args: {
      where: { tenant_id: string; id: string };
      select: Record<string, true>;
    }): Promise<RequisitionAllowlistRow | null>;
  };
}

// The strict column allowlist — recruiting context only. No compensation
// (pay_rate_* / bill_rate_* / placement_fee_* / salary_*) or financial-
// planning (target_margin_percent / markup_percent_target / rate_card_id
// / min|max_bill_rate / min|max_pay_rate) column appears, so none can
// enter a snapshot regardless of caller authorization.
const REQUISITION_CONTEXT_SELECT: Record<string, true> = {
  id: true,
  tenant_id: true,
  version: true,
  golden_profile_id: true,
  title: true,
  job_type: true,
  labor_category: true,
  role_family: true,
  seniority_level: true,
  city: true,
  state: true,
  postal_code: true,
  work_arrangement: true,
  onsite_days_per_week: true,
  travel_percent: true,
  relocation_offered: true,
  duration_value: true,
  duration_unit: true,
  hours_per_week: true,
  extension_possible: true,
  work_authorization: true,
};

// CI-B2 — the concrete Requisition analysis-context reader.
//
// Resolves the allowlisted recruiting context for a (tenant,
// requisition) pair by reading:
//   1. the Requisition row, via the requisition module's PrismaService,
//      with a STRICT column allowlist `select` — the gated compensation
//      (pay_rate_* / bill_rate_* / placement_fee_* / salary_*) and
//      financial-planning (target_margin_percent / markup_percent_target
//      / rate_card_id / min|max_bill_rate / min|max_pay_rate) columns
//      are NOT selected, so they never enter this process's memory. This
//      is the D5-by-construction posture the requisition repository uses
//      for its publish sweep (listPublishableForChannelSync) — masking
//      by non-selection, the strongest form.
//   2. the GoldenProfile CONTENT (when the requisition references one),
//      via JobDomainRepository. GoldenProfile is mutable in place with
//      no version/hash, so the snapshot copies its CONTENT (not a mere
//      pointer) to preserve reproducibility (directive §10 GoldenProfile
//      reproducibility). The profile is tenant-guarded: a profile row
//      whose tenant_id does not match is treated as absent (conceal),
//      never copied.
//
// Tenant isolation is by concealment: the requisition read leads with
// `tenant_id`, and a miss returns `null` (the service maps that to a
// concealing NOT_FOUND). No cross-tenant existence is revealed.
@Injectable()
export class RequisitionGoldenProfileContextReader
  implements RequisitionAnalysisContextReader
{
  constructor(
    @Inject(RequisitionPrismaService)
    private readonly requisitionPrisma: RequisitionReadClient,
    private readonly jobDomain: JobDomainRepository,
  ) {}

  async load(input: {
    tenant_id: string;
    requisition_id: string;
  }): Promise<RequisitionAnalysisSource | null> {
    const row = await this.requisitionPrisma.requisition.findFirst({
      where: { tenant_id: input.tenant_id, id: input.requisition_id },
      select: REQUISITION_CONTEXT_SELECT,
    });

    if (row === null) {
      // Conceal: the requisition does not exist in this tenant.
      return null;
    }

    const goldenProfileId = row.golden_profile_id ?? null;
    const goldenProfileContent =
      goldenProfileId === null
        ? null
        : await this.loadGoldenProfileContent(input.tenant_id, goldenProfileId);

    return {
      tenant_id: row.tenant_id,
      requisition_id: row.id,
      source_requisition_version: row.version,
      golden_profile_id: goldenProfileId,
      title: row.title,
      job_type: row.job_type ?? null,
      labor_category: row.labor_category ?? null,
      role_family: row.role_family ?? null,
      seniority_level: row.seniority_level ?? null,
      city: row.city ?? null,
      state: row.state ?? null,
      postal_code: row.postal_code ?? null,
      work_arrangement: row.work_arrangement ?? null,
      onsite_days_per_week: row.onsite_days_per_week ?? null,
      travel_percent: row.travel_percent ?? null,
      relocation_offered: row.relocation_offered,
      duration_value: row.duration_value ?? null,
      duration_unit: row.duration_unit ?? null,
      hours_per_week: row.hours_per_week ?? null,
      extension_possible: row.extension_possible,
      work_authorization: row.work_authorization ?? null,
      golden_profile_content: goldenProfileContent,
    };
  }

  private async loadGoldenProfileContent(
    tenant_id: string,
    golden_profile_id: string,
  ): Promise<RequisitionAnalysisSource['golden_profile_content']> {
    const profile = await this.jobDomain.findGoldenProfileById(
      golden_profile_id,
    );
    // Tenant-guard: a profile resolved for the wrong tenant is treated as
    // absent (conceal), never copied into the snapshot.
    if (profile === null || profile.tenant_id !== tenant_id) {
      return null;
    }
    return goldenProfileContentFromStorage({
      skills: profile.skills,
      experience: profile.experience,
      constraints: profile.constraints,
    });
  }
}
