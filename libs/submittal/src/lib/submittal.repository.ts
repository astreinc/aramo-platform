import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { EvidenceRepository } from '@aramo/evidence';

import type {
  CreateSubmittalInput,
  FailedCriterionAcknowledgment,
  SubmittalStateValue,
  TalentSubmittalRecordView,
} from './dto/talent-submittal-record.view.js';
import { PrismaService } from './prisma/prisma.service.js';

// SubmittalRepository — M4 PR-3 §4.3.
//
// Owns the write path for TalentSubmittalRecord and orchestrates the
// cross-schema build of the immutable TalentJobEvidencePackage via PR-2's
// EvidenceRepository.buildPackage. The orchestration is repository-layer
// (not a service layer) per PR-2's Ruling 2 precedent — minimal
// orchestration belongs in the repository.
//
// Surface (closed):
//   - createSubmittal: build the evidence package + persist the
//     TalentSubmittalRecord in state='draft'.
//   - findById: tenant-scoped read by submittal_record id.
//   - findByTenantAndEvidencePackage: lookup by (tenant, evidence_package_id)
//     for cross-schema resolution (F34 will use this).
//
// Cross-schema invariant (Architecture §7.3): evidence_package_id and
// pinned_examination_id are UUID-only references with no DB FK. Write-time
// validation is delegated to buildPackage (which calls
// ExaminationRepository.findById + findByIdFull for the
// examination_id → examination schema integrity check).
//
// Tenant isolation (Architecture §7.2): every method scopes by tenant_id.

interface TalentSubmittalRecordRow {
  id: string;
  tenant_id: string;
  talent_id: string;
  job_id: string;
  evidence_package_id: string;
  pinned_examination_id: string;
  state: SubmittalStateValue;
  created_by: string;
  justification: string | null;
  failed_criterion_acknowledgments: unknown;
  created_at: Date;
  confirmed_at: Date | null;
}

function projectView(row: TalentSubmittalRecordRow): TalentSubmittalRecordView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    talent_id: row.talent_id,
    job_id: row.job_id,
    evidence_package_id: row.evidence_package_id,
    pinned_examination_id: row.pinned_examination_id,
    state: row.state,
    created_by: row.created_by,
    justification: row.justification,
    failed_criterion_acknowledgments:
      row.failed_criterion_acknowledgments === null
        ? null
        : (row.failed_criterion_acknowledgments as readonly FailedCriterionAcknowledgment[]),
    created_at: row.created_at,
    confirmed_at: row.confirmed_at,
  };
}

@Injectable()
export class SubmittalRepository {
  private readonly logger = new Logger(SubmittalRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly evidenceRepository: EvidenceRepository,
  ) {}

  // M4 PR-3 §4.3 — create flow.
  //
  // Five steps (directive §4.3):
  //   1) Generate evidence_package_id + submittal_id UUIDs (caller never
  //      supplies; the repository owns ID minting).
  //   2) Call evidenceRepository.buildPackage({...input,
  //      id: evidence_package_id}). buildPackage handles its own input
  //      validation (UUIDs, non-empty payloads), examination read,
  //      Stretch refusal, optional rate read, and the
  //      TalentJobEvidencePackage write. Any thrown AramoError
  //      (SUBMITTAL_STRETCH_BLOCKED, NOT_FOUND, VALIDATION_ERROR) flows
  //      back to the controller without further wrapping.
  //   3) prisma.talentSubmittalRecord.create with state='draft',
  //      evidence_package_id from step 2, pinned_examination_id from
  //      input.examination_id, justification + failed_criterion
  //      _acknowledgments persisted verbatim.
  //   4) Return the typed view projection.
  //   5) Structured logging at entry, success, refusal-bubble-through.
  async createSubmittal(
    input: CreateSubmittalInput,
  ): Promise<TalentSubmittalRecordView> {
    const startedAt = Date.now();

    // Step 1 — mint IDs.
    const evidencePackageId = randomUUID();
    const submittalId = randomUUID();

    this.logger.log({
      event: 'submittal_create_started',
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
      job_id: input.job_id,
      examination_id: input.examination_id,
      submittal_id: submittalId,
      evidence_package_id: evidencePackageId,
    });

    // Step 2 — build evidence package. Any refusal (Stretch, NOT_FOUND,
    // VALIDATION_ERROR) propagates as-thrown — the controller layer
    // surfaces them to the HTTP client. No catch here.
    await this.evidenceRepository.buildPackage({
      id: evidencePackageId,
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
      job_id: input.job_id,
      examination_id: input.examination_id,
      // PR-3 does NOT pre-populate submittal_record_id on the evidence
      // package at create time. The cross-schema reference is one-way:
      // TalentSubmittalRecord.evidence_package_id → evidence package.
      // The evidence package's submittal_record_id stays nullable per
      // PR-1's M5-forward-reference posture.
      talent_identity: input.talent_identity,
      contact_summary: input.contact_summary,
      capability_summary_overrides: input.capability_summary_overrides,
      ...(input.match_justification_overrides !== undefined
        ? { match_justification_overrides: input.match_justification_overrides }
        : {}),
      recruiter_contribution: input.recruiter_contribution,
      ...(input.rate_expectation_id !== undefined
        ? { rate_expectation_id: input.rate_expectation_id }
        : {}),
      ...(input.engagement_event_refs !== undefined
        ? { engagement_event_refs: input.engagement_event_refs }
        : {}),
    });

    // Step 3 — write the TalentSubmittalRecord row in state='draft'.
    //
    // Prisma 7 nullable Json columns: passing JS `null` is rejected at
    // the typed surface; the special `Prisma.JsonNull` sentinel signals
    // "store JSONB NULL." When the input omits failed_criterion_
    // acknowledgments, we want the column to be NULL in the database.
    // For string columns (justification), JS null is accepted directly.
    const dataPayload: Record<string, unknown> = {
      id: submittalId,
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
      job_id: input.job_id,
      evidence_package_id: evidencePackageId,
      pinned_examination_id: input.examination_id,
      state: 'draft',
      created_by: input.created_by,
      justification: input.justification ?? null,
    };
    if (input.failed_criterion_acknowledgments !== undefined) {
      dataPayload['failed_criterion_acknowledgments'] = [
        ...input.failed_criterion_acknowledgments,
      ];
    }
    const created = await this.prisma.talentSubmittalRecord.create({
      data: dataPayload as never,
    });

    const view = projectView(created as TalentSubmittalRecordRow);

    // Step 5 — success log.
    this.logger.log({
      event: 'submittal_created',
      tenant_id: view.tenant_id,
      submittal_id: view.id,
      evidence_package_id: view.evidence_package_id,
      talent_id: view.talent_id,
      job_id: view.job_id,
      examination_id: view.pinned_examination_id,
      latency_ms: Date.now() - startedAt,
    });

    return view;
  }

  async findById(input: {
    tenant_id: string;
    id: string;
  }): Promise<TalentSubmittalRecordView | null> {
    const row = await this.prisma.talentSubmittalRecord.findFirst({
      where: { tenant_id: input.tenant_id, id: input.id },
    });
    return row === null ? null : projectView(row as TalentSubmittalRecordRow);
  }

  async findByTenantAndEvidencePackage(input: {
    tenant_id: string;
    evidence_package_id: string;
  }): Promise<TalentSubmittalRecordView | null> {
    const row = await this.prisma.talentSubmittalRecord.findFirst({
      where: {
        tenant_id: input.tenant_id,
        evidence_package_id: input.evidence_package_id,
      },
    });
    return row === null ? null : projectView(row as TalentSubmittalRecordRow);
  }
}
