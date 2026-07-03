import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { JobDomainRepository } from '@aramo/job-domain';
import { MatchingService } from '@aramo/matching';
import { RequisitionRepository } from '@aramo/requisition';
import { TalentEvidenceRepository } from '@aramo/talent-evidence';
import { TalentExtractionService } from '@aramo/talent-extraction';
import { TalentRecordRepository } from '@aramo/talent-record';

import {
  buildMatchingInput,
  isRoleFamily,
  newExaminationId,
  type GoldenConstraints,
} from '../matching-derivation/derive-matching-input.js';

// Gate-1 G1-B — the pairing-level EXAMINE endpoint. POST /v1/examinations
// { talent_id, requisition_id } MINTS a TalentJobExamination for the (talent,
// job) pairing: lazy declared-evidence extraction (idempotent — skipped when
// evidence already exists) → deterministic derivation → sync
// MatchingService.evaluateAndPersist.
//
// ⚠️ T1 DEFERRAL (Option C, mint-only): the minted examination is NOT yet
// visible via GET /v1/jobs/:id/matches. That Live List resolves through a
// job-domain Requisition keyed to the ATS requisition id — the T1 Core/ATS
// identity bridge that is DEFERRED (its own Phase-B carry doc:
// Aramo-Carry-T1-Identity-Bridge-and-ATS-…-Store-Phase-B). This endpoint
// asserts the examination is MINTED + correct (tier / evidence / keying); FE
// Live-List visibility lands with the T1 bridge increment. We do NOT fabricate
// the bridge here.

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ExamineRequestDto {
  talent_id: string;
  requisition_id: string;
}

interface ExamineResponseDto {
  examination_id: string;
  talent_id: string;
  job_id: string;
  golden_profile_id: string;
  tier: string;
  // T1-deferred: not yet visible in GET /v1/jobs/:id/matches (see class note).
  live_list_visible: false;
}

@Controller('v1/examinations')
@UseGuards(JwtAuthGuard)
export class ExamineController {
  constructor(
    private readonly talentRecordRepository: TalentRecordRepository,
    private readonly requisitionRepository: RequisitionRepository,
    private readonly jobDomainRepository: JobDomainRepository,
    private readonly talentEvidenceRepository: TalentEvidenceRepository,
    private readonly talentExtractionService: TalentExtractionService,
    private readonly matchingService: MatchingService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async examine(
    @Body() body: ExamineRequestDto,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ExamineResponseDto> {
    this.assertConsumerIsRecruiter(authContext, requestId);
    const talent_id = this.assertUuid(body?.talent_id, 'talent_id', requestId);
    const requisition_id = this.assertUuid(
      body?.requisition_id,
      'requisition_id',
      requestId,
    );
    const tenant_id = authContext.tenant_id;

    // Step 1 — resolve the requisition (tenant-scoped floor; per-recruiter
    // requisition-visibility scoping is a follow-up) → golden_profile_id.
    const requisition = await this.requisitionRepository.findByIdAdmin({
      tenant_id,
      id: requisition_id,
    });
    if (requisition === null) {
      throw new AramoError('NOT_FOUND', 'Requisition not found in tenant', 404, {
        requestId,
        details: { requisition_id },
      });
    }
    if (requisition.golden_profile_id === null) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Requisition has no confirmed Golden Profile — run Generate/confirm profile first',
        422,
        { requestId, details: { requisition_id } },
      );
    }

    // Step 2 — read the confirmed GoldenProfile (job half of the input).
    const golden = await this.jobDomainRepository.findGoldenProfileById(
      requisition.golden_profile_id,
    );
    if (golden === null || golden.tenant_id !== tenant_id) {
      throw new AramoError('NOT_FOUND', 'Golden Profile not found in tenant', 404, {
        requestId,
        details: { golden_profile_id: requisition.golden_profile_id },
      });
    }
    const roleFamilyRaw = (golden.skills as { role_family?: unknown } | null)
      ?.role_family;
    if (!isRoleFamily(roleFamilyRaw)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Golden Profile role_family is missing or not a recognized role family',
        422,
        { requestId, details: { golden_profile_id: golden.id } },
      );
    }

    // Step 3 — read the talent (constraint sources + contact channel).
    const talent = await this.talentRecordRepository.findById({
      tenant_id,
      id: talent_id,
    });
    if (talent === null) {
      throw new AramoError('NOT_FOUND', 'TalentRecord not found in tenant', 404, {
        requestId,
        details: { talent_id },
      });
    }

    // Step 4 — LAZY + IDEMPOTENT declared-evidence extraction. Guard is the
    // exists-check (NOT an upsert): re-examine does not duplicate evidence rows.
    const existing = await this.talentEvidenceRepository.countTalentSkillEvidenceByTalent(
      { tenant_id, talent_id },
    );
    if (existing === 0) {
      const resume_text = await this.talentRecordRepository.findResumeRedactedText({
        tenant_id,
        talent_record_id: talent_id,
      });
      await this.talentExtractionService.extractDeclaredEvidence({
        tenant_id,
        talent_id,
        ...(resume_text !== null ? { resume_text } : {}),
        ...(talent.key_skills !== null ? { key_skills: talent.key_skills } : {}),
      });
    }

    // Step 5 — read declared skill evidence + derive the input.
    const declared = await this.talentEvidenceRepository.findTalentSkillEvidenceByTalent(
      { tenant_id, talent_id },
    );
    const input = buildMatchingInput({
      examination_id: newExaminationId(),
      tenant_id,
      talent_id,
      job_id: golden.job_id, // Option C keying: examination.job_id = GoldenProfile.job_id.
      golden_profile_id: golden.id,
      computed_at: new Date(),
      role_family: roleFamilyRaw,
      critical_skill_names: golden.critical_skills,
      golden_constraints: (golden.constraints as GoldenConstraints | null) ?? {},
      declared_skills: declared,
      talent: {
        city: talent.city,
        state: talent.state,
        desired_pay: talent.desired_pay,
        work_authorization: talent.work_authorization,
        has_contact_channel:
          talent.email1 !== null ||
          talent.email2 !== null ||
          talent.phone_cell !== null ||
          talent.phone_home !== null ||
          talent.phone_work !== null,
      },
    });

    // Step 6 — SYNC mint (evaluateAndPersist → ExaminationRepository.createSnapshot).
    const examination = await this.matchingService.evaluateAndPersist(input);

    return {
      examination_id: examination.id,
      talent_id,
      job_id: examination.job_id,
      golden_profile_id: examination.golden_profile_id,
      tier: examination.tier,
      live_list_visible: false,
    };
  }

  private assertConsumerIsRecruiter(
    authContext: AuthContextType,
    requestId: string,
  ): void {
    if (authContext.consumer_type !== 'recruiter') {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'examine endpoint is recruiter-only',
        403,
        { requestId, details: { consumer_type: authContext.consumer_type } },
      );
    }
  }

  private assertUuid(value: string, field: string, requestId: string): string {
    if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
      throw new AramoError('INVALID_REQUEST', `${field} must be a UUID`, 400, {
        requestId,
        details: { field },
      });
    }
    return value;
  }
}
