import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  ExaminationRepository,
  type TalentJobExaminationFullView,
} from '@aramo/examination';
import { TalentEvidenceRepository } from '@aramo/talent-evidence';

import type {
  BuildPackageInput,
  CapabilitySummary,
  ContactSummary,
  MatchJustification,
  RecruiterContribution,
  TalentIdentity,
  TalentJobEvidencePackageView,
} from './dto/talent-job-evidence-package.view.js';
import { PrismaService } from './prisma/prisma.service.js';

// Repository for the TalentJobEvidencePackage model (M4 PR-1 §4.3 + M4
// PR-2 §4.1).
//
// Surface scope (closed):
//   - findById, findByTenantAndSubmittal, findByTenantAndTalent
//     (PR-1, READ-ONLY).
//   - buildPackage (PR-2 §4.1, WRITE).
//
// PR-1 (read-only): The three read methods project JSONB columns through
// typed view casts at the boundary (PR-6 §4.2 precedent).
//
// PR-2 (write): The buildPackage method takes a BuildPackageInput, reads
// the referenced TalentJobExamination via ExaminationRepository.findById
// + Full projection, optionally reads TalentRateExpectation via
// TalentEvidenceRepository, validates the Stretch-tier refusal and
// examination presence + lifecycle invariants, composes the five JSONB
// payloads, and writes one immutable TalentJobEvidencePackage row.
//
// Belt-and-suspenders immutability (PR-1 invariant preserved by PR-2):
//   - The PR-1 BEFORE UPDATE trigger continues to reject any UPDATE on
//     freshly-built rows (integration test §4.7 item 7 confirms).
//   - PR-2's write surface is create-only; no update method is exposed.
//
// Tenant isolation (Architecture §7.2): every read method takes
// tenant_id; the builder cross-checks input.tenant_id against the
// referenced TalentJobExamination.tenant_id and refuses NOT_FOUND on
// mismatch (Architecture §7.2 — cross-tenant reads surface as 404, not
// 403).
//
// Cross-schema write validation (Architecture §7.3 — UUID-only, no FK):
// PR-2 introduces the first cross-schema write path in libs/evidence
// (TalentJobEvidencePackage.examination_id → examination schema). Per
// §7.3, write-time application-layer validation is required; the builder
// satisfies this via ExaminationRepository.findById which verifies the
// UUID points to an actual row (and the talent/job ID cross-checks
// catch caller inconsistency). submittal_record_id and
// engagement_event_refs[] remain forward-references (M5 entities not
// yet on substrate); PR-1's nullable / empty-array-default posture is
// preserved.
//
// Observability (Ruling 7 / Plan v1.5 §M4 "observability per-PR
// standard from M4 onward"): minimum INFO-level structured logging on
// build entry, refusal paths, and successful exit, carrying the
// canonical fields (tenant_id, talent_id, job_id, examination_id,
// evidence_package_id post-write, latency). Full observability
// standardization (library choice, metrics, traces, dashboards) lands
// in its dedicated M4 PR.

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

// PR-2 §4.1 step 1 — input validation helpers. UUID regex matches Postgres
// uuid_generate format (v4/v7); whitespace-only strings are non-empty
// per .length but logically empty per the directive's intent — trim.

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

@Injectable()
export class EvidenceRepository {
  private readonly logger = new Logger(EvidenceRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly examinationRepository: ExaminationRepository,
    private readonly talentEvidenceRepository: TalentEvidenceRepository,
  ) {}

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

  // M4 PR-2 §4.1 — evidence-package builder. Nine-step flow:
  //   1) input validation         → VALIDATION_ERROR
  //   2) examination read         → NOT_FOUND / VALIDATION_ERROR
  //   3) Stretch-tier refusal     → SUBMITTAL_STRETCH_BLOCKED
  //   4) optional rate read       → NOT_FOUND on missing/tenant-mismatch
  //   5) derive examination-side payloads from the Full view
  //   6) compose recruiter_contribution payload
  //   7) write via prisma.create
  //   8) return persisted row
  //   9) structured logging (entry / refusal / success)
  //
  // Directive divergence (Gate 5 report item): TalentJobExaminationFullView
  // does not carry tenant_id (Summary base exposes talent_id + job_id but
  // not tenant). The builder therefore reads the raw row via
  // ExaminationRepository.findById (which DOES carry tenant_id) and uses
  // the Full view (also fetched via findByIdFull) only for the projected
  // analytical fields. Two reads against the same row PK; both findUnique
  // — cheap.
  async buildPackage(
    input: BuildPackageInput,
  ): Promise<TalentJobEvidencePackageView> {
    const startedAt = Date.now();

    // Step 9 (entry log) — emit before the validation work so refused
    // builds are always paired with a started log.
    this.logger.log({
      event: 'evidence_package_build_started',
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
      job_id: input.job_id,
      examination_id: input.examination_id,
    });

    // ---- Step 1: input validation ---------------------------------------
    this.validateBuildInput(input);

    // ---- Step 2: examination read --------------------------------------
    //
    // Two reads against the same row PK:
    //   - findById   → raw row (tenant_id, lifecycle_state, all columns)
    //   - findByIdFull → projected Full view (analytical fields)
    //
    // Both reads find by id only (no tenant filter at the read layer); the
    // builder cross-checks tenant_id against the raw row before any
    // downstream work. Cross-tenant reads surface as NOT_FOUND per
    // Architecture §7.2.
    const examinationRow = await this.examinationRepository.findById(
      input.examination_id,
    );
    if (examinationRow === null) {
      this.logRefused('NOT_FOUND', input);
      throw new AramoError(
        'NOT_FOUND',
        'TalentJobExamination not found',
        404,
        {
          requestId: 'builder',
          details: {
            examination_id: input.examination_id,
          },
        },
      );
    }

    // Tenant cross-check (Architecture §7.2 — cross-tenant reads return 404).
    if (examinationRow.tenant_id !== input.tenant_id) {
      this.logRefused('NOT_FOUND', input);
      throw new AramoError(
        'NOT_FOUND',
        'TalentJobExamination not found in tenant',
        404,
        {
          requestId: 'builder',
          details: {
            examination_id: input.examination_id,
            input_tenant_id: input.tenant_id,
          },
        },
      );
    }

    // Lifecycle cross-check — non-active state surfaces as NOT_FOUND so a
    // recruiter cannot reach back to an archived / cold-storage snapshot
    // to build a new package. The lifecycle_state value is included in
    // the message for diagnostic visibility (PII-free; closed-enum value).
    if (examinationRow.lifecycle_state !== 'active') {
      this.logRefused('NOT_FOUND', input);
      throw new AramoError(
        'NOT_FOUND',
        `TalentJobExamination is ${examinationRow.lifecycle_state}`,
        404,
        {
          requestId: 'builder',
          details: {
            examination_id: input.examination_id,
            lifecycle_state: examinationRow.lifecycle_state,
          },
        },
      );
    }

    // Examination-side talent/job cross-checks (caller-bug VALIDATION_ERROR).
    if (examinationRow.talent_id !== input.talent_id) {
      this.logRefused('VALIDATION_ERROR', input);
      throw new AramoError(
        'VALIDATION_ERROR',
        'examination_id does not reference the named talent_id',
        400,
        {
          requestId: 'builder',
          details: {
            examination_id: input.examination_id,
            input_talent_id: input.talent_id,
            examination_talent_id: examinationRow.talent_id,
          },
        },
      );
    }
    if (examinationRow.job_id !== input.job_id) {
      this.logRefused('VALIDATION_ERROR', input);
      throw new AramoError(
        'VALIDATION_ERROR',
        'examination_id does not reference the named job_id',
        400,
        {
          requestId: 'builder',
          details: {
            examination_id: input.examination_id,
            input_job_id: input.job_id,
            examination_job_id: examinationRow.job_id,
          },
        },
      );
    }

    // findByIdFull supplies the projected analytical fields the builder
    // composes capability_summary + match_justification from. findById has
    // already confirmed the row exists, the tenant matches, the lifecycle
    // is active, and the talent/job IDs match — findByIdFull is guaranteed
    // non-null at this point, but the type system can't know that.
    const examinationFull = await this.examinationRepository.findByIdFull(
      input.examination_id,
    );
    if (examinationFull === null) {
      // Defensive — should be unreachable given findById succeeded above.
      this.logRefused('NOT_FOUND', input);
      throw new AramoError(
        'NOT_FOUND',
        'TalentJobExamination Full view projection failed',
        404,
        {
          requestId: 'builder',
          details: { examination_id: input.examination_id },
        },
      );
    }

    // ---- Step 3: Stretch-tier refusal ----------------------------------
    if (examinationFull.tier === 'STRETCH') {
      this.logger.log({
        event: 'evidence_package_build_refused_stretch',
        tenant_id: input.tenant_id,
        examination_id: input.examination_id,
      });
      throw new AramoError(
        'SUBMITTAL_STRETCH_BLOCKED',
        'Stretch-tier examinations cannot be submitted',
        422,
        {
          requestId: 'builder',
          details: {
            examination_id: input.examination_id,
            tier: examinationFull.tier,
          },
          displayMessage:
            'This talent does not meet Aramo\'s submittal threshold.',
          logMessage: `submittal_blocked: tier=STRETCH examination=${input.examination_id}`,
        },
      );
    }

    // ---- Step 4: optional rate substrate read --------------------------
    let rateSubPayload: {
      min_rate: number;
      target_rate: number | null;
      currency: string;
      period: 'HOURLY' | 'ANNUAL';
      source: 'talent_declared' | 'recruiter_entered';
      employment_type: 'W2' | '1099' | 'C2C' | 'FTE';
    } | null = null;

    if (
      input.rate_expectation_id !== undefined &&
      input.rate_expectation_id !== null
    ) {
      const rateRow =
        await this.talentEvidenceRepository.findTalentRateExpectationById(
          input.rate_expectation_id,
        );
      if (rateRow === null) {
        this.logRefused('NOT_FOUND', input);
        throw new AramoError(
          'NOT_FOUND',
          'TalentRateExpectation not found',
          404,
          {
            requestId: 'builder',
            details: { rate_expectation_id: input.rate_expectation_id },
          },
        );
      }
      if (rateRow.tenant_id !== input.tenant_id) {
        this.logRefused('NOT_FOUND', input);
        throw new AramoError(
          'NOT_FOUND',
          'TalentRateExpectation not found in tenant',
          404,
          {
            requestId: 'builder',
            details: {
              rate_expectation_id: input.rate_expectation_id,
              input_tenant_id: input.tenant_id,
            },
          },
        );
      }
      rateSubPayload = {
        min_rate: rateRow.min_rate,
        target_rate: rateRow.target_rate,
        currency: rateRow.currency,
        period: rateRow.period,
        source: rateRow.source,
        employment_type: rateRow.employment_type,
      };
    }

    // ---- Step 5: derive examination-side payloads ---------------------
    const capabilitySummary = composeCapabilitySummary(examinationFull, input);
    const matchJustification = composeMatchJustification(examinationFull, input);

    // ---- Step 6: compose recruiter_contribution payload ---------------
    const recruiterContributionPayload = composeRecruiterContribution(
      input,
      rateSubPayload,
    );

    // ---- Step 7: write via prisma.create -------------------------------
    const engagementEventRefs = [...(input.engagement_event_refs ?? [])];

    const created = await this.prisma.talentJobEvidencePackage.create({
      data: {
        id: input.id,
        tenant_id: input.tenant_id,
        talent_id: input.talent_id,
        job_id: input.job_id,
        examination_id: input.examination_id,
        submittal_record_id: input.submittal_record_id ?? null,
        parent_package_id: input.parent_package_id ?? null,
        talent_identity: input.talent_identity as never,
        contact_summary: input.contact_summary as never,
        capability_summary: capabilitySummary as never,
        match_justification: matchJustification as never,
        recruiter_contribution: recruiterContributionPayload as never,
        engagement_event_refs: engagementEventRefs as never,
      },
    });

    const view = projectView(created as TalentJobEvidencePackageRow);

    // ---- Step 8 / Step 9 (success log) --------------------------------
    this.logger.log({
      event: 'evidence_package_built',
      tenant_id: view.tenant_id,
      evidence_package_id: view.id,
      talent_id: view.talent_id,
      job_id: view.job_id,
      examination_id: view.examination_id,
      latency_ms: Date.now() - startedAt,
    });

    return view;
  }

  // ---- Step 1 helpers ----------------------------------------------------

  private validateBuildInput(input: BuildPackageInput): void {
    // Identity UUIDs — caller-supplied; well-formedness check.
    const identityFields: ReadonlyArray<['id' | 'tenant_id' | 'talent_id' | 'job_id' | 'examination_id', string]> = [
      ['id', input.id],
      ['tenant_id', input.tenant_id],
      ['talent_id', input.talent_id],
      ['job_id', input.job_id],
      ['examination_id', input.examination_id],
    ];
    for (const [name, value] of identityFields) {
      if (typeof value !== 'string' || value.length === 0) {
        this.logRefused('VALIDATION_ERROR', input);
        throw new AramoError(
          'VALIDATION_ERROR',
          `BuildPackageInput.${name} is required`,
          400,
          {
            requestId: 'builder',
            details: { invalid_field: name },
          },
        );
      }
      if (!isUuid(value)) {
        this.logRefused('VALIDATION_ERROR', input);
        throw new AramoError(
          'VALIDATION_ERROR',
          `BuildPackageInput.${name} is not a well-formed UUID`,
          400,
          {
            requestId: 'builder',
            details: { invalid_field: name },
          },
        );
      }
    }

    // Recruiter-authored content non-emptiness.
    if (!isNonEmpty(input.talent_identity.full_name)) {
      this.logRefused('VALIDATION_ERROR', input);
      throw new AramoError(
        'VALIDATION_ERROR',
        'talent_identity.full_name is required',
        400,
        { requestId: 'builder', details: { invalid_field: 'talent_identity.full_name' } },
      );
    }
    if (!isNonEmpty(input.talent_identity.location)) {
      this.logRefused('VALIDATION_ERROR', input);
      throw new AramoError(
        'VALIDATION_ERROR',
        'talent_identity.location is required',
        400,
        { requestId: 'builder', details: { invalid_field: 'talent_identity.location' } },
      );
    }
    if (typeof input.contact_summary.contact_available !== 'boolean') {
      this.logRefused('VALIDATION_ERROR', input);
      throw new AramoError(
        'VALIDATION_ERROR',
        'contact_summary.contact_available must be a boolean',
        400,
        { requestId: 'builder', details: { invalid_field: 'contact_summary.contact_available' } },
      );
    }
    if (!isNonEmpty(input.recruiter_contribution.conversation_summary.recruiter_summary)) {
      this.logRefused('VALIDATION_ERROR', input);
      throw new AramoError(
        'VALIDATION_ERROR',
        'recruiter_contribution.conversation_summary.recruiter_summary is required',
        400,
        {
          requestId: 'builder',
          details: {
            invalid_field:
              'recruiter_contribution.conversation_summary.recruiter_summary',
          },
        },
      );
    }
    if (
      typeof input.recruiter_contribution.talent_confirmed.spoken_to_recruiter !==
      'boolean'
    ) {
      this.logRefused('VALIDATION_ERROR', input);
      throw new AramoError(
        'VALIDATION_ERROR',
        'recruiter_contribution.talent_confirmed.spoken_to_recruiter must be a boolean',
        400,
        {
          requestId: 'builder',
          details: {
            invalid_field:
              'recruiter_contribution.talent_confirmed.spoken_to_recruiter',
          },
        },
      );
    }
  }

  private logRefused(
    code: 'NOT_FOUND' | 'VALIDATION_ERROR',
    input: BuildPackageInput,
  ): void {
    this.logger.log({
      event: 'evidence_package_build_refused',
      error_code: code,
      tenant_id: input.tenant_id,
      examination_id: input.examination_id,
    });
  }
}

// ---- Step 5 / Step 6 composers ----------------------------------------

function composeCapabilitySummary(
  full: TalentJobExaminationFullView,
  input: BuildPackageInput,
): CapabilitySummary {
  const certifications = input.capability_summary_overrides.certifications;
  const summary: CapabilitySummary = {
    skill_match: full.skill_match,
    experience_match: full.experience_match,
    key_work_history: [...input.capability_summary_overrides.key_work_history],
  };
  if (certifications !== undefined) {
    summary.certifications = [...certifications];
  }
  return summary;
}

function composeMatchJustification(
  full: TalentJobExaminationFullView,
  input: BuildPackageInput,
): MatchJustification {
  const overrides = input.match_justification_overrides;
  return {
    why_this_talent: overrides?.why_this_talent ?? full.why_matched_sentence,
    strengths:
      overrides?.strengths !== undefined
        ? [...overrides.strengths]
        : [...full.strengths],
    gaps:
      overrides?.gaps !== undefined
        ? [...overrides.gaps]
        : [...full.gaps],
    risk_flags:
      overrides?.risk_flags !== undefined
        ? [...overrides.risk_flags]
        : [...full.risk_flags],
  };
}

function composeRecruiterContribution(
  input: BuildPackageInput,
  rateSubPayload: {
    min_rate: number;
    target_rate: number | null;
    currency: string;
    period: 'HOURLY' | 'ANNUAL';
    source: 'talent_declared' | 'recruiter_entered';
    employment_type: 'W2' | '1099' | 'C2C' | 'FTE';
  } | null,
): RecruiterContribution & { talent_confirmed: { rate?: unknown } } {
  const recruiterInput = input.recruiter_contribution;
  const talentConfirmed: RecruiterContribution['talent_confirmed'] & {
    rate?: unknown;
  } = {
    spoken_to_recruiter: recruiterInput.talent_confirmed.spoken_to_recruiter,
  };
  if (recruiterInput.talent_confirmed.availability_confirmed !== undefined) {
    talentConfirmed.availability_confirmed = true;
  }
  if (recruiterInput.talent_confirmed.work_authorization !== undefined) {
    talentConfirmed.work_authorization =
      recruiterInput.talent_confirmed.work_authorization;
  }
  if (rateSubPayload !== null) {
    talentConfirmed.rate = rateSubPayload;
  }
  const payload: RecruiterContribution & {
    talent_confirmed: { rate?: unknown };
  } = {
    conversation_summary: {
      recruiter_summary:
        recruiterInput.conversation_summary.recruiter_summary,
    },
    talent_confirmed: talentConfirmed,
  };
  if (recruiterInput.screening_notes !== undefined) {
    payload.screening_notes = recruiterInput.screening_notes;
  }
  return payload;
}
