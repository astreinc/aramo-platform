import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError } from '@aramo/common';
import { type AuthContextType } from '@aramo/auth';
import { TalentExtractionService } from '@aramo/talent-extraction';

import type { CreateTalentRecordRequestDto } from '../dto/create-talent-record-request.dto.js';
import type { TalentRecordView } from '../dto/talent-record.view.js';
import { TalentRecordRepository } from '../talent-record.repository.js';
import { TalentCreateFromDraftService } from '../talent-create-from-draft.service.js';

import { asReviewPayload } from './talent-intake-review.js';

// Durable Async Résumé-First Talent Intake — PROMOTE. The ONLY step that creates
// a TalentRecord. It REUSES the shared TalentCreateFromDraftService 3-phase
// composition (canonical Talent create + Documents + evidence) — no duplicated
// Talent-create logic — then guards the parent's promotion linkage. Race-safety
// comes from the canonical create transaction (idempotent on the reserved id, via
// the child ACCEPTED guard) PLUS the guarded promoted_talent_record_id: repeated
// or racing promotion converges to exactly one TalentRecord.
@Injectable()
export class TalentIntakePromotionService {
  constructor(
    private readonly talentExtraction: TalentExtractionService,
    private readonly createFromDraft: TalentCreateFromDraftService,
    private readonly repo: TalentRecordRepository,
  ) {}

  async promote(
    authContext: AuthContextType,
    id: string,
    requestId: string,
  ): Promise<TalentRecordView> {
    const tenant_id = authContext.tenant_id;
    const created_by = authContext.sub;
    const intake = await this.talentExtraction.findTalentIntakeDraftById({ tenant_id, id, created_by });
    if (intake === null) {
      throw new AramoError('NOT_FOUND', 'Talent intake draft not found.', 404, {
        requestId,
        details: { id },
      });
    }

    // Idempotent: already promoted → return the existing TalentRecord.
    if (intake.promoted_talent_record_id !== null) {
      const existing = await this.repo.findById({ tenant_id, id: intake.promoted_talent_record_id });
      if (existing !== null) {
        return existing;
      }
    }

    // ADMISSION is the ONLY creation prerequisite (§9/§13): a name, a primary
    // email, and a cell phone. Extraction state is NOT a gate — a FAILED or still-
    // reading résumé never blocks creation. This is checked up-front for BOTH the
    // governed and the manual paths.
    const body = this.buildCreateInput(intake);
    const email1 = (body.email1 ?? '').trim();
    const phoneCell = (body.phone_cell ?? '').trim();
    const missing: string[] = [];
    if ((body.first_name ?? '').trim() === '') missing.push('first_name');
    if ((body.last_name ?? '').trim() === '') missing.push('last_name');
    if (email1 === '') missing.push('email1');
    if (phoneCell === '') missing.push('phone_cell');
    if (missing.length > 0) {
      // Admission invariant — no TalentRecord is created when required fields are
      // missing (field-keyed so the FE can direct the recruiter).
      throw new AramoError(
        'VALIDATION_ERROR',
        'A name, a primary email, and a cell phone are required to create a talent.',
        422,
        { requestId, details: { missing } },
      );
    }

    // GOVERNED path — only when a résumé-extraction child exists AND is
    // confirmable (READY_FOR_REVIEW). Reuses the SHARED create-from-draft
    // composition (canonical create + Documents + governed evidence;
    // CAS-converges on a concurrent confirm).
    if (intake.resume_extraction_draft_id !== null) {
      const created = await this.createFromDraft.confirmCreateFromDraftUpload(
        authContext,
        body,
        email1,
        requestId,
      );
      if (created !== null) {
        await this.talentExtraction.markTalentIntakeDraftPromoted({
          tenant_id,
          id,
          created_by,
          promoted_talent_record_id: created.id,
          promoted_at: new Date(),
        });
        return created;
      }
      // The child is not confirmable (FAILED / PROCESSING / REJECTED). First
      // converge on a racing promote; otherwise fall THROUGH to the manual path —
      // a non-reviewable child must NOT block creation (§13).
      const reread = await this.talentExtraction.findTalentIntakeDraftById({ tenant_id, id, created_by });
      if (reread?.promoted_talent_record_id != null) {
        const existing = await this.repo.findById({ tenant_id, id: reread.promoted_talent_record_id });
        if (existing !== null) {
          return existing;
        }
      }
    }

    // MANUAL admission path (§13) — no governed extraction evidence is available
    // (no child, or a child that never reached READY_FOR_REVIEW). Mint a reserved
    // id and CLAIM the promotion linkage: the guarded markTalentIntakeDraftPromoted
    // (promoted_talent_record_id IS NULL) is the single convergence point, so a
    // racing/duplicate promote resolves to exactly one TalentRecord. The create is
    // then idempotent on the claimed id.
    const reservedId = uuidv7();
    const claimed = await this.talentExtraction.markTalentIntakeDraftPromoted({
      tenant_id,
      id,
      created_by,
      promoted_talent_record_id: reservedId,
      promoted_at: new Date(),
    });
    let linkedId = reservedId;
    if (claimed === 0) {
      // Lost the claim (already promoted) → converge on the winner's record id.
      const reread = await this.talentExtraction.findTalentIntakeDraftById({ tenant_id, id, created_by });
      if (reread?.promoted_talent_record_id != null) {
        linkedId = reread.promoted_talent_record_id;
      }
    }
    return this.createFromDraft.createManualFromReview(authContext, body, email1, linkedId, requestId);
  }

  // Construct the canonical create input from the persisted review payload + the
  // governed extraction child. Recruiter-reviewed values are the source of truth;
  // the draft_id links the child so the shared composition promotes its evidence.
  private buildCreateInput(intake: {
    storage_key: string | null;
    source_filename: string | null;
    mime_type: string | null;
    size_bytes: number | null;
    resume_extraction_draft_id: string | null;
    review_payload: unknown;
  }): CreateTalentRecordRequestDto {
    const review = asReviewPayload(intake.review_payload);
    const str = (key: string): string | undefined => {
      const f = review.fields[key];
      if (f === undefined || typeof f.value !== 'string') return undefined;
      const trimmed = f.value.trim();
      return trimmed === '' ? undefined : trimmed;
    };
    const bool = (key: string): boolean | undefined => {
      const f = review.fields[key];
      return f !== undefined && typeof f.value === 'boolean' ? f.value : undefined;
    };
    const prov = review.resume_provenance ?? {};
    const body = {
      // Admission anchors (default to '' so the service's missing-field guard
      // reports them precisely).
      first_name: str('first_name') ?? '',
      last_name: str('last_name') ?? '',
      email1: str('email1') ?? '',
      phone_cell: str('phone_cell') ?? '',
      // Every other recruiter-reviewed scalar the create contract accepts — carried
      // through so no persisted edit is lost on promotion. Undefined keys are
      // dropped below.
      email2: str('email2'),
      phone_home: str('phone_home'),
      phone_work: str('phone_work'),
      web_site: str('web_site'),
      best_time_to_call: str('best_time_to_call'),
      address: str('address'),
      address2: str('address2'),
      city: str('city'),
      state: str('state'),
      zip: str('zip'),
      country: str('country'),
      current_employer: str('current_employer'),
      title: str('title'),
      key_skills: str('key_skills'),
      availability_status: str('availability_status'),
      engagement_type: str('engagement_type'),
      work_authorization: str('work_authorization'),
      date_available: str('date_available'),
      current_pay: str('current_pay'),
      desired_pay: str('desired_pay'),
      source: str('source'),
      notes: str('notes'),
      can_relocate: bool('can_relocate'),
      is_hot: bool('is_hot'),
      work_history: review.work_history as CreateTalentRecordRequestDto['work_history'],
      skills: review.skills as CreateTalentRecordRequestDto['skills'],
      education: review.education as CreateTalentRecordRequestDto['education'],
      certifications: review.certifications as CreateTalentRecordRequestDto['certifications'],
      draft_id: intake.resume_extraction_draft_id ?? undefined,
      // resume_document is attached ONLY for artifact-backed sources. A
      // non-upload source (ADR-0033 §5, storage_key null) promotes with no
      // résumé evidence document.
      ...(intake.storage_key !== null
        ? {
            resume_document: {
              storage_key: intake.storage_key,
              file_name: intake.source_filename ?? 'resume',
              mime_type: intake.mime_type ?? 'application/octet-stream',
              size_bytes: intake.size_bytes ?? 0,
              source_map_version: prov.source_map_version,
              resume_text_hash: prov.resume_text_hash,
            },
          }
        : {}),
    };
    // Drop undefined scalar keys so the create contract sees them as "not set".
    const cleaned = Object.fromEntries(
      Object.entries(body).filter(([, v]) => v !== undefined),
    );
    return cleaned as unknown as CreateTalentRecordRequestDto;
  }
}
