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
// a TalentRecord. Extraction is async ENRICHMENT, never a prerequisite (ADR-0033
// local gap): a confirmable governed child promotes through the shared 3-phase
// composition (confirmCreateFromDraftUpload); otherwise the recruiter-reviewed
// fields alone create the Talent (createFromReviewedUpload). Two settled
// invariants hold across BOTH paths:
//   G1 — actor-private authority: every draft read/mutation is scoped by
//        tenant_id + created_by, so a same-tenant recruiter/manager can NEVER
//        promote another recruiter's draft by id.
//   Exactly-once/replay-safe: a replay of an already-promoted draft returns the
//        existing record; concurrent promotion converges — the guarded
//        promotion-linkage CAS (promoted_talent_record_id IS NULL) elects ONE
//        winner and the create is idempotent on the claimed reserved id.
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
    // G1 — actor-scoped read: a non-owner resolves null → 404 (existence not leaked).
    const intake = await this.talentExtraction.findTalentIntakeDraftById({ tenant_id, id, created_by });
    if (intake === null) {
      throw new AramoError('NOT_FOUND', 'Talent intake draft not found.', 404, {
        requestId,
        details: { id },
      });
    }

    // Idempotent / replay-safe: already promoted → return the existing TalentRecord.
    if (intake.promoted_talent_record_id !== null) {
      const existing = await this.repo.findById({ tenant_id, id: intake.promoted_talent_record_id });
      if (existing !== null) {
        return existing;
      }
    }

    // ADMISSION is the ONLY creation prerequisite (§9/§13 + ADR-0033 local-gap):
    // a name, a primary email, and a cell phone. Extraction state is NEVER a gate —
    // a FAILED / still-reading / absent extraction never blocks creation.
    const body = this.buildCreateInput(intake);
    const email1 = (body.email1 ?? '').trim();
    const phoneCell = (body.phone_cell ?? '').trim();
    const missing: string[] = [];
    if ((body.first_name ?? '').trim() === '') missing.push('first_name');
    if ((body.last_name ?? '').trim() === '') missing.push('last_name');
    if (email1 === '') missing.push('email1');
    if (phoneCell === '') missing.push('phone_cell');
    if (missing.length > 0) {
      // Field-keyed so the FE can direct the recruiter.
      throw new AramoError(
        'VALIDATION_ERROR',
        'A name, a primary email, and a cell phone are required to create a talent.',
        422,
        { requestId, details: { missing } },
      );
    }

    // ENRICHMENT path — a confirmable governed extraction child (READY_FOR_REVIEW)
    // promotes through the shared 3-phase composition so its accepted résumé
    // evidence lifecycle is linked (it carries its own reserved-id convergence). A
    // null result means the child is not promotable (PROCESSING / FAILED / decided
    // elsewhere) → fall through to the decoupled create rather than block (§13).
    if (intake.resume_extraction_draft_id !== null) {
      const created = await this.createFromDraft.confirmCreateFromDraftUpload(
        authContext,
        body,
        email1,
        requestId,
      );
      if (created !== null) {
        // Link the parent (guarded CAS; G1 actor-scoped).
        await this.talentExtraction.markTalentIntakeDraftPromoted({
          tenant_id,
          id,
          created_by,
          promoted_talent_record_id: created.id,
          promoted_at: new Date(),
        });
        return created;
      }
      // Child not confirmable → converge on a racing promote, else fall through.
      const reread = await this.talentExtraction.findTalentIntakeDraftById({ tenant_id, id, created_by });
      if (reread?.promoted_talent_record_id != null) {
        const existing = await this.repo.findById({ tenant_id, id: reread.promoted_talent_record_id });
        if (existing !== null) {
          return existing;
        }
      }
    }

    // DECOUPLED path — no confirmable governed child (absent, or the async
    // EventBridge→SQS→consumer/LLM path is slow/failed). The recruiter-reviewed
    // fields alone create the Talent; the résumé artifact stays attached.
    //
    // Convergence (PO/Lead merge ruling — exactly-once / replay-safe):
    //   1. The hard active-email duplicate rule is enforced BEFORE any linkage
    //      claim, so a blocked promote never leaves a stuck PROMOTED-but-recordless
    //      draft. (A different active record with this email → 409.)
    //   2. CLAIM the promotion linkage with a reserved id (guarded CAS); the single
    //      winner then creates idempotently on that id. A racing/replayed promote
    //      loses the claim and converges on the winner's record. → EXACTLY ONE
    //      TalentRecord + one linkage.
    const dup = await this.repo.findActiveByEmail({ tenant_id, email: email1 });
    if (dup !== null) {
      throw new AramoError(
        'TALENT_RECORD_DUPLICATE',
        'A talent with this primary email already exists in your tenant.',
        409,
        { requestId, details: { email1, existing_id: dup.id } },
      );
    }
    const reservedId = uuidv7();
    const claimed = await this.talentExtraction.markTalentIntakeDraftPromoted({
      tenant_id,
      id,
      created_by,
      promoted_talent_record_id: reservedId,
      promoted_at: new Date(),
    });
    if (claimed === 0) {
      // Lost the claim (concurrent/replay) → converge on the winner's linked id.
      const reread = await this.talentExtraction.findTalentIntakeDraftById({ tenant_id, id, created_by });
      const linkedId = reread?.promoted_talent_record_id ?? reservedId;
      const existing = await this.repo.findById({ tenant_id, id: linkedId });
      if (existing !== null) {
        return existing;
      }
      // Winner claimed but has not finished creating yet (rare window) → complete
      // idempotently on the winner's id.
      return this.createFromDraft.createFromReviewedUpload(authContext, body, email1, requestId, linkedId);
    }
    // We own the linkage → create idempotently on the reserved id.
    return this.createFromDraft.createFromReviewedUpload(authContext, body, email1, requestId, reservedId);
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
