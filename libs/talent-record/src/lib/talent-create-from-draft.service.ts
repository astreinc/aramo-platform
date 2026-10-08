import { Injectable, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError } from '@aramo/common';
import { type AuthContextType } from '@aramo/auth';
import { CanonicalReconcileProducer } from '@aramo/canonical-reconcile';
import { TalentReconcileProducer } from '@aramo/talent-reconcile-signal';
import { ResumeParserService } from '@aramo/resume-parse';
import {
  TalentExtractionService,
  ResumeExtractionDraftNotReviewableError,
} from '@aramo/talent-extraction';

import type { CreateTalentRecordRequestDto } from './dto/create-talent-record-request.dto.js';
import type { WorkAuthorization } from './dto/stated-fields.js';
import type { TalentRecordView } from './dto/talent-record.view.js';
import { TalentRecordRepository } from './talent-record.repository.js';
import { ResumeEditionIngestionService } from './resume-extraction/resume-edition-ingestion.service.js';
import { ResumeTextService } from './resume-text/resume-text.service.js';

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
    // ADR-0033 local-gap decoupling — the résumé-edition companion + the resume
    // -text reindex writer + the artifact-SHA parser, so the extraction-decoupled
    // create (createFromReviewedUpload) mints the SAME résumé evidence the manual
    // create does. @Optional + appended LAST so hand-wired unit-test `new
    // TalentCreateFromDraftService(...)` sites keep positional alignment; apps/api
    // wires TalentRecordModule (which provides all three) in production.
    @Optional() private readonly editionIngestion?: ResumeEditionIngestionService,
    @Optional() private readonly resumeText?: ResumeTextService,
    @Optional() private readonly resumeParser?: ResumeParserService,
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

  // ADR-0033 local-gap PO ruling — the EXTRACTION-DECOUPLED create. Résumé
  // extraction is async ENRICHMENT, never an admission prerequisite: when no
  // governed extraction child is available (child absent / still PROCESSING /
  // FAILED — e.g. the EventBridge→SQS→consumer path is unhealthy), the recruiter
  // -reviewed fields ALONE create the Talent. Composition mirrors the manual
  // create() non-draft path (TalentRecordController) using the SAME shared
  // building blocks — repo.create (admission invariant rides inside) + best-effort
  // résumé TalentDocument + edition + reindex + declared evidence + reconcile +
  // work-auth. The résumé artifact STAYS attached (createResumeDocument keyed on
  // storage_key). An originating extraction child, if supplied via body.draft_id,
  // is linked + ACCEPTED best-effort (no-op when absent). Extraction can never
  // mutate the created TalentRecord (it writes only the child + intake row), so a
  // late extraction after a manual promote never overwrites recruiter-confirmed
  // state.
  async createFromReviewedUpload(
    authContext: AuthContextType,
    body: CreateTalentRecordRequestDto,
    email1: string,
    requestId: string,
  ): Promise<TalentRecordView> {
    const tenant_id = authContext.tenant_id;
    // Dedup on the admission anchor — a DIFFERENT active record with this primary
    // email is a conflict (same 409 as the manual create + the draft-backed path).
    const duplicate = await this.repo.findActiveByEmail({ tenant_id, email: email1 });
    if (duplicate !== null) {
      throw new AramoError(
        'TALENT_RECORD_DUPLICATE',
        'A talent with this primary email already exists in your tenant.',
        409,
        { requestId, details: { email1, existing_id: duplicate.id } },
      );
    }
    // The FINAL admission step — the admission invariant (name + email1 +
    // phone_cell) rides structurally inside repo.create.
    const created = await this.repo.create({
      tenant_id,
      entered_by_id: authContext.sub,
      input: body,
      requestId,
    });

    // Best-effort provenance/evidence block — the Talent IS created; a document/
    // edition/evidence hiccup never fails the create (mirrors the manual path).
    let sourceDocumentId: string | undefined;
    let resumeEditionId: string | undefined;
    let artifactSha: string | undefined;
    try {
      const rd = body.resume_document;
      if (rd !== undefined && typeof rd.storage_key === 'string' && rd.storage_key !== '') {
        try {
          const hashed = await this.resumeParser?.computeArtifactSha256FromStorageKey?.({
            storage_key: rd.storage_key,
            requestId,
          });
          artifactSha = hashed?.artifact_sha256;
        } catch {
          artifactSha = undefined;
        }
        sourceDocumentId = await this.talentExtraction.createResumeDocument({
          talent_id: created.id,
          tenant_id,
          uploaded_by_actor_id: authContext.sub,
          storage_key: rd.storage_key,
          filename: rd.file_name,
          mime_type: rd.mime_type,
          size_bytes: rd.size_bytes,
          artifact_sha256: artifactSha,
        });
      }
      if (
        sourceDocumentId !== undefined &&
        typeof rd?.resume_text_hash === 'string' &&
        rd.resume_text_hash !== ''
      ) {
        const editionResult = await this.editionIngestion?.createEditionForDocument({
          tenant_id,
          talent_id: created.id,
          talent_document_id: sourceDocumentId,
          content_hash: rd.resume_text_hash,
          artifact_sha256: artifactSha,
          created_by: authContext.sub,
        });
        resumeEditionId = editionResult?.edition.id;
        if (resumeEditionId !== undefined && typeof rd?.storage_key === 'string' && rd.storage_key !== '') {
          try {
            await this.resumeText?.enqueueReindex({
              tenant_id,
              talent_record_id: created.id,
              storage_key: rd.storage_key,
              resume_edition_id: resumeEditionId,
            });
          } catch {
            // non-fatal
          }
        }
      }
      const provenance = {
        ...(sourceDocumentId !== undefined ? { source_document_id: sourceDocumentId } : {}),
        ...(rd?.source_map_version !== undefined ? { source_map_version: rd.source_map_version } : {}),
        ...(rd?.resume_text_hash !== undefined ? { resume_text_hash: rd.resume_text_hash } : {}),
      };
      if (Array.isArray(body.work_history) && body.work_history.length > 0) {
        await this.talentExtraction.persistDeclaredWorkHistory({
          talent_id: created.id,
          tenant_id,
          entries: body.work_history,
          provenance,
        });
      }
      if (Array.isArray(body.skills) && body.skills.length > 0) {
        await this.talentExtraction.persistDeclaredSkills({
          talent_id: created.id,
          tenant_id,
          skills: body.skills,
          provenance,
        });
      }
      if (Array.isArray(body.education) && body.education.length > 0) {
        await this.talentExtraction.persistDeclaredEducation({
          talent_id: created.id,
          tenant_id,
          education: body.education,
          provenance,
        });
      }
      if (Array.isArray(body.certifications) && body.certifications.length > 0) {
        await this.talentExtraction.persistDeclaredCertifications({
          talent_id: created.id,
          tenant_id,
          certifications: body.certifications,
          provenance,
        });
      }
    } catch {
      // Non-fatal: the record is created; the recruiter can add evidence on the
      // Talent record. (No PII in logs.)
    }

    await this.canonicalReconcile?.enqueueTalent(tenant_id, created.id);
    await this.talentReconcile?.enqueueTalent(tenant_id, created.id);
    await this.recordWorkAuthEvidence(authContext, created.id, body);

    // CREATE_DRAFT_UPLOAD close-out — if an originating extraction child was
    // supplied, LINK it + mark ACCEPTED (best-effort, guarded; a 0-count / absent
    // child is a benign no-op). No re-promotion: evidence was written above.
    if (typeof body.draft_id === 'string' && body.draft_id !== '') {
      try {
        await this.talentExtraction.markResumeExtractionDraftAccepted({
          id: body.draft_id,
          tenant_id,
          talent_id: created.id,
          talent_document_id: sourceDocumentId ?? null,
          resume_edition_id: resumeEditionId ?? null,
          reviewed_by: authContext.sub,
          reviewed_at: new Date(),
        });
      } catch {
        // Non-fatal: the Talent + evidence exist; a draft-link hiccup never fails.
      }
    }
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
