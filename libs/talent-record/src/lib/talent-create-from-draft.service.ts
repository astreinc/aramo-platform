import { Injectable, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError } from '@aramo/common';
import { type AuthContextType } from '@aramo/auth';
import { CanonicalReconcileProducer } from '@aramo/canonical-reconcile';
import { TalentReconcileProducer } from '@aramo/talent-reconcile-signal';
import {
  TalentExtractionService,
  ResumeExtractionDraftNotReviewableError,
} from '@aramo/talent-extraction';

import type { CreateTalentRecordRequestDto } from './dto/create-talent-record-request.dto.js';
import type { WorkAuthorization } from './dto/stated-fields.js';
import type { TalentRecordView } from './dto/talent-record.view.js';
import { TalentRecordRepository } from './talent-record.repository.js';

// The SHARED CREATE-from-draft promotion authority (TI-1F-B), extracted verbatim
// from TalentRecordController so BOTH the synchronous create()-with-draft path AND
// the durable async Talent-intake PROMOTE path run ONE identical 3-phase
// composition — no duplicated Talent-create / Documents / evidence logic.
//
//   PHASE 1  establishCreateDraftEvidence against a reserved talent_id (atomic
//            Document + edition + default + typed evidence; CAS-converges on a
//            concurrent confirm)
//   PHASE 2  TalentRecordRepository.create({ id: reservedId }) — the FINAL
//            admission step, idempotent on the reserved id (admission invariant
//            rides inside create)
//   PHASE 3  markResumeExtractionDraftAccepted (guarded READY_FOR_REVIEW→ACCEPTED)
//            + reconcile signals + governed work-authorization evidence
//
// Reused by TalentIntakePromotionService: the intake promote builds a
// CreateTalentRecordRequestDto from the persisted review payload + the governed
// extraction child, then calls confirmCreateFromDraftUpload here.
@Injectable()
export class TalentCreateFromDraftService {
  constructor(
    private readonly repo: TalentRecordRepository,
    private readonly talentExtraction: TalentExtractionService,
    @Optional() private readonly canonicalReconcile?: CanonicalReconcileProducer,
    @Optional() private readonly talentReconcile?: TalentReconcileProducer,
  ) {}

  async confirmCreateFromDraftUpload(
    authContext: AuthContextType,
    body: CreateTalentRecordRequestDto,
    email1: string,
    requestId: string,
  ): Promise<TalentRecordView | null> {
    const tenant_id = authContext.tenant_id;
    const draftId = body.draft_id as string;
    const draft = await this.talentExtraction.findResumeExtractionDraftById({ tenant_id, id: draftId });
    if (draft === null || draft.source_kind !== 'CREATE_DRAFT_UPLOAD') return null;

    // Already fully promoted (idempotent duplicate submit) → return the Talent.
    if (draft.status === 'ACCEPTED') {
      if (draft.talent_id != null) {
        const existing = await this.repo.findById({ tenant_id, id: draft.talent_id });
        if (existing !== null) return existing;
      }
      return null;
    }
    // A PROCESSING / FAILED / REJECTED draft is not confirmable here → normal path.
    if (draft.status !== 'READY_FOR_REVIEW') return null;

    // Reserved identity: reuse the linked id on a retry, else it is minted in phase 1.
    let reservedId: string | undefined = draft.talent_id ?? undefined;
    let documentId: string | undefined = draft.talent_document_id ?? undefined;
    let editionId: string | undefined = draft.resume_edition_id ?? undefined;

    // Dedup with the reserved-id exception: our OWN in-flight Talent (a retry after
    // phase 2 committed) is not a duplicate; a DIFFERENT active record with the same
    // email is.
    const duplicate = await this.repo.findActiveByEmail({ tenant_id, email: email1 });
    if (duplicate !== null && duplicate.id !== reservedId) {
      throw new AramoError(
        'TALENT_RECORD_DUPLICATE',
        'A talent with this primary email already exists in your tenant.',
        409,
        { requestId, details: { email1, existing_id: duplicate.id } },
      );
    }

    const rd = body.resume_document!;
    // PHASE 1 — establish the accepted evidence lifecycle (atomic) if not yet linked.
    if (draft.talent_id == null) {
      const reserved = uuidv7();
      try {
        const established = await this.talentExtraction.establishCreateDraftEvidence({
          tenant_id,
          talent_id: reserved,
          actor_id: authContext.sub,
          draft_id: draftId,
          resume_document: {
            storage_key: rd.storage_key,
            file_name: rd.file_name,
            mime_type: rd.mime_type,
            size_bytes: rd.size_bytes,
            source_map_version: rd.source_map_version,
            resume_text_hash: rd.resume_text_hash,
          },
          work_history: body.work_history,
          skills: body.skills,
          education: body.education,
          certifications: body.certifications,
        });
        reservedId = reserved;
        documentId = established.document_id;
        editionId = established.edition_id;
      } catch (err) {
        // Lost the phase-1 CAS to a concurrent confirm → re-read + reuse the
        // winner's linked identity (converge, no duplicate Talent/evidence).
        if (err instanceof ResumeExtractionDraftNotReviewableError) {
          const relinked = await this.talentExtraction.findResumeExtractionDraftById({ tenant_id, id: draftId });
          if (relinked?.talent_id != null) {
            reservedId = relinked.talent_id;
            documentId = relinked.talent_document_id ?? undefined;
            editionId = relinked.resume_edition_id ?? undefined;
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
    }
    if (reservedId === undefined) return null; // defensive — never expected

    // PHASE 2 — TalentRecord is the FINAL admission step, idempotent on the reserved id.
    let created = await this.repo.findById({ tenant_id, id: reservedId });
    if (created === null) {
      created = await this.repo.create({
        tenant_id,
        entered_by_id: authContext.sub,
        input: body,
        requestId,
        id: reservedId,
      });
    }

    // PHASE 3 — only NOW does the draft cross into a durable Talent: ACCEPTED.
    // Guarded READY_FOR_REVIEW→ACCEPTED (idempotent; a prior success is a no-op).
    await this.talentExtraction.markResumeExtractionDraftAccepted({
      id: draftId,
      tenant_id,
      talent_id: reservedId,
      talent_document_id: documentId ?? null,
      resume_edition_id: editionId ?? null,
      reviewed_by: authContext.sub,
      reviewed_at: new Date(),
    });

    // §4-H — both reconcile signals after the durable Talent exists (best-effort).
    await this.canonicalReconcile?.enqueueTalent(tenant_id, reservedId);
    await this.talentReconcile?.enqueueTalent(tenant_id, reservedId);
    // TI-1G §1 — an explicit work-auth value on the confirmed create is a governed
    // assertion (resume-backed create has NO special authority — same path).
    await this.recordWorkAuthEvidence(authContext, reservedId, body);
    return created;
  }

  // TALENT-INTEL-1 TI-1G §1 — append governed RIGHT_TO_WORK evidence when a Create/
  // Edit carries an EXPLICIT work-authorization VALUE. Best-effort: the scalar
  // (written by repo.create/update) is the immediate current projection; a durable-
  // evidence hiccup never fails the operation. A CLEAR (null/empty) or an OMITTED
  // field writes NO value-evidence — the governed clear is the existing
  // EXPLICITLY_CLEARED field-state; omitted is untouched. NO inference.
  async recordWorkAuthEvidence(
    authContext: AuthContextType,
    talentId: string,
    body: { work_authorization?: string | null },
  ): Promise<void> {
    const wa = body.work_authorization;
    if (typeof wa !== 'string' || wa.trim() === '') return;
    try {
      await this.talentExtraction.recordDeclaredWorkAuthorization({
        talent_id: talentId,
        tenant_id: authContext.tenant_id,
        work_authorization_status: wa as WorkAuthorization,
        asserted_by: authContext.sub,
      });
    } catch {
      // non-fatal — the scalar is the user-facing current state; evidence is durable
      // history recorded best-effort (no resume/backfill path re-creates it).
    }
  }
}
