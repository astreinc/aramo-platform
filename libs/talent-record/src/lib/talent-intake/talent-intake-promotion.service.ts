import { Inject, Injectable, Optional } from '@nestjs/common';
import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';
import { AramoError } from '@aramo/common';
import { type AuthContextType } from '@aramo/auth';
import { ResumeParserService } from '@aramo/resume-parse';
import { TalentExtractionService } from '@aramo/talent-extraction';
import type { TalentIntakeDraftRow } from '@aramo/talent-evidence';

import type { CreateTalentRecordRequestDto } from '../dto/create-talent-record-request.dto.js';
import type { WorkAuthorization } from '../dto/stated-fields.js';
import type { TalentRecordView } from '../dto/talent-record.view.js';
import {
  RECRUITER_CREATE_CONSENT_DEFAULT,
  applyRecruiterCreateConsentDefault,
  type RecruiterCreateConsentDefaultPort,
} from '../recruiter-create-consent-default.port.js';
import {
  TalentRecordRepository,
  talentDuplicateError,
  validateTalentCreateInput,
} from '../talent-record.repository.js';

import { asReviewPayload, reviewEvidencePayloadHash } from './talent-intake-review.js';

// Namespace for the deterministic per-Talent ids the Save mints for its
// idempotent follow-up writes (uuid v5 over the reserved TalentRecord id).
const SAVE_WORK_AUTH_NAMESPACE = '6f4b8a52-2f0e-4c55-9d3e-6a1c7e0b9d21';

// ATI-SEP-1 A2 (Addendum A2 A-a) — Draft → Human Review → SAVE. The ONLY step
// that creates a TalentRecord from an intake draft; route POST
// /v1/talent-intake-drafts/:id/promote and its TalentRecordView response are
// unchanged. Create is the Save of the PERSISTED, recruiter-reviewed draft:
//
//   load    actor-scoped (G1 — a non-owner resolves 404); a fully saved draft
//           replays its TalentRecord.
//   validate admission (422) + stated fields / date_available (400) FIRST — a
//           rejected Save changes nothing; the draft stays editable.
//   dedupe  a DIFFERENT live record with this email1 or normalized phone_cell →
//           409 TALENT_RECORD_DUPLICATE { reason } (no state change).
//   step 0  RESERVE the TalentRecord id on the draft (SAVING). Concurrent Saves
//           elect one id via the reservation CAS and all resume on it.
//   step 1  materialize the reviewed ATS evidence (talent_evidence txn; claimed
//           on the draft, so a re-Save never duplicates it): résumé Document +
//           edition + default, typed evidence incl. experience assertions, and
//           the extraction child linked + ACCEPTED when still reviewable.
//           The run is stamped with a hash of the reviewed arrays (D6): a
//           resumed Save whose TalentRecord does not exist yet and whose arrays
//           changed since (the recruiter edited the draft after a partial Save)
//           re-materializes them atomically, so no edit is silently lost. Once
//           the record exists, PATCH refuses such edits (409) instead.
//   step 2  TalentRecord + talent.created outbox row (+ the first edition's
//           pending text row) in ONE talent_record txn, idempotent on the
//           reserved id; the email/phone duplicate is re-checked under lock.
//   step 3  consent default (fail-soft port) + the stated work-authorization as
//           ATS evidence (deterministic id → appended once).
//   step 4  ONLY NOW mark the draft PROMOTED (guarded on the reservation).
//
// Any failure leaves the draft non-PROMOTED and editable; the next Save resumes
// on the reserved id, skipping the completed steps. A PROMOTED draft without a
// TalentRecord cannot arise. Extraction state never gates a Save. Nothing here
// calls a trust / identity / reconcile surface — downstream consumers react to
// the committed talent.created event (ATI-SEP-1 F-1).
@Injectable()
export class TalentIntakePromotionService {
  constructor(
    private readonly talentExtraction: TalentExtractionService,
    private readonly repo: TalentRecordRepository,
    // Artifact byte SHA-256 when the intake row has none yet (best-effort read of
    // the retained object; a miss leaves the edition hashless, as before).
    @Optional() private readonly resumeParser?: ResumeParserService,
    // CONSENT-RECRUITER-CREATE-DEFAULT-1 — the at-create contact-consent default.
    @Optional()
    @Inject(RECRUITER_CREATE_CONSENT_DEFAULT)
    private readonly recruiterCreateConsentDefault?: RecruiterCreateConsentDefaultPort,
  ) {}

  async promote(
    authContext: AuthContextType,
    id: string,
    requestId: string,
  ): Promise<TalentRecordView> {
    const tenant_id = authContext.tenant_id;
    const created_by = authContext.sub;
    const intake = await this.load(tenant_id, id, created_by, requestId);

    // Replay: a fully saved draft returns its TalentRecord.
    if (intake.promoted_talent_record_id !== null) {
      const existing = await this.repo.findById({ tenant_id, id: intake.promoted_talent_record_id });
      if (existing !== null) {
        return existing;
      }
    }

    // VALIDATION FIRST — nothing below runs (and nothing is written) unless the
    // reviewed values would be admitted.
    const body = this.buildCreateInput(intake);
    const missing: string[] = [];
    if ((body.first_name ?? '').trim() === '') missing.push('first_name');
    if ((body.last_name ?? '').trim() === '') missing.push('last_name');
    if ((body.email1 ?? '').trim() === '') missing.push('email1');
    if ((body.phone_cell ?? '').trim() === '') missing.push('phone_cell');
    if (missing.length > 0) {
      // Field-keyed so the FE can direct the recruiter.
      throw new AramoError(
        'VALIDATION_ERROR',
        'A name, a primary email, and a cell phone are required to create a talent.',
        422,
        { requestId, details: { missing } },
      );
    }
    validateTalentCreateInput(body, requestId);

    // Tenant-local dedupe (email1 + normalized phone_cell). Our own reserved id
    // (a resumed Save whose record already committed) is not a duplicate.
    const priorReserved = intake.save_reserved_talent_record_id ?? null;
    const dup = await this.repo.findActiveDuplicate({
      tenant_id,
      email1: body.email1,
      phone_cell: body.phone_cell,
      ...(priorReserved !== null ? { exclude_id: priorReserved } : {}),
    });
    if (dup !== null) {
      // A concurrent Save of THIS draft may have reserved + created since our
      // read: its record is ours, not a duplicate.
      const current = priorReserved === null ? await this.load(tenant_id, id, created_by, requestId) : null;
      if (current?.save_reserved_talent_record_id !== dup.id) {
        throw talentDuplicateError(dup, requestId);
      }
    }

    // STEP 0 — reserve (or resume on) the TalentRecord id.
    const reservedId = await this.reserve(intake, created_by, requestId);

    // STEP 1 — ATS evidence, materialized once per (draft, reserved id) and
    // re-materialized (pre-record only) when the reviewed arrays changed.
    const rd = body.resume_document;
    const payloadHash = reviewEvidencePayloadHash(asReviewPayload(intake.review_payload));
    let editionId: string | null = null;
    let record: TalentRecordView | null = null;
    if (intake.save_evidence_materialized_at != null) {
      record = await this.repo.findById({ tenant_id, id: reservedId });
      if (record === null && (intake.save_evidence_payload_hash ?? null) !== payloadHash) {
        await this.talentExtraction.rematerializeIntakeSaveEvidence({
          tenant_id,
          intake_draft_id: intake.id,
          talent_id: reservedId,
          payload_hash: payloadHash,
          resume_document:
            rd !== undefined
              ? {
                  ...(rd.source_map_version !== undefined ? { source_map_version: rd.source_map_version } : {}),
                  ...(rd.resume_text_hash !== undefined ? { resume_text_hash: rd.resume_text_hash } : {}),
                }
              : null,
          work_history: body.work_history,
          skills: body.skills,
          education: body.education,
          certifications: body.certifications,
        });
      }
    } else {
      const artifactSha = rd !== undefined ? await this.artifactSha(intake, rd.storage_key, requestId) : undefined;
      const evidence = await this.talentExtraction.materializeIntakeSaveEvidence({
        tenant_id,
        intake_draft_id: intake.id,
        talent_id: reservedId,
        actor_id: created_by,
        resume_document:
          rd !== undefined
            ? {
                storage_key: rd.storage_key,
                file_name: rd.file_name,
                mime_type: rd.mime_type,
                size_bytes: rd.size_bytes,
                ...(artifactSha !== undefined ? { artifact_sha256: artifactSha } : {}),
                ...(rd.source_map_version !== undefined ? { source_map_version: rd.source_map_version } : {}),
                ...(rd.resume_text_hash !== undefined ? { resume_text_hash: rd.resume_text_hash } : {}),
              }
            : null,
        work_history: body.work_history,
        skills: body.skills,
        education: body.education,
        certifications: body.certifications,
        extraction_child_id: intake.resume_extraction_draft_id,
        payload_hash: payloadHash,
      });
      editionId = evidence.edition_id;
    }

    // STEP 2 — the TalentRecord (+ talent.created) on the reserved id.
    record ??= await this.repo.findById({ tenant_id, id: reservedId });
    if (record === null) {
      if (editionId === null && rd !== undefined) {
        // Resumed Save: the edition minted by an earlier step 1 is the Talent's
        // default (it is the reserved Talent's first and only edition).
        const def = await this.talentExtraction.getDefaultResumeEdition({ tenant_id, talent_id: reservedId });
        editionId = def?.resume_edition_id ?? null;
      }
      record = await this.repo.create({
        tenant_id,
        entered_by_id: created_by,
        input: body,
        requestId,
        id: reservedId,
        dedupe: true,
        event: { intake_draft_id: intake.id, correlation_id: requestId },
        ...(editionId !== null && rd !== undefined
          ? { resume_reindex: { storage_key: rd.storage_key, resume_edition_id: editionId } }
          : {}),
      });
    }

    // STEP 3 — at-create follow-ups, idempotent on the reserved id.
    await applyRecruiterCreateConsentDefault(this.recruiterCreateConsentDefault, {
      talent_record_id: reservedId,
      authContext,
      requestId,
    });
    // TI-1G §1 — an explicit stated work-authorization is ATS evidence (no
    // inference; a résumé never reaches this — the recruiter-reviewed scalar).
    const wa = body.work_authorization;
    if (typeof wa === 'string' && wa.trim() !== '') {
      await this.talentExtraction.recordDeclaredWorkAuthorization({
        id: uuidv5(`intake-save-work-authorization:${reservedId}`, SAVE_WORK_AUTH_NAMESPACE),
        talent_id: reservedId,
        tenant_id,
        work_authorization_status: wa as WorkAuthorization,
        asserted_by: created_by,
      });
    }

    // STEP 4 — every step is complete: the draft is now PROMOTED.
    await this.talentExtraction.completeTalentIntakeDraftSave({
      tenant_id,
      id: intake.id,
      created_by,
      talent_record_id: reservedId,
      promoted_at: new Date(),
    });
    return record;
  }

  private async load(
    tenant_id: string,
    id: string,
    created_by: string,
    requestId: string,
  ): Promise<TalentIntakeDraftRow> {
    // G1 — actor-scoped read: a non-owner resolves null → 404 (existence not leaked).
    const intake = await this.talentExtraction.findTalentIntakeDraftById({ tenant_id, id, created_by });
    if (intake === null) {
      throw new AramoError('NOT_FOUND', 'Talent intake draft not found.', 404, {
        requestId,
        details: { id },
      });
    }
    return intake;
  }

  // STEP 0 — the reservation CAS elects ONE id across concurrent Saves; a loser
  // re-reads and resumes on the winner's.
  private async reserve(
    intake: TalentIntakeDraftRow,
    created_by: string,
    requestId: string,
  ): Promise<string> {
    const prior = intake.save_reserved_talent_record_id ?? null;
    if (prior !== null) return prior;
    await this.talentExtraction.reserveTalentIntakeDraftSave({
      tenant_id: intake.tenant_id,
      id: intake.id,
      created_by,
      reserved_talent_record_id: uuidv7(),
    });
    const reread = await this.load(intake.tenant_id, intake.id, created_by, requestId);
    const reserved = reread.save_reserved_talent_record_id ?? null;
    if (reserved === null) {
      // Promoted elsewhere between the read and the reservation (a pre-A2 draft
      // with a linkage and no reservation) — nothing to resume here.
      throw new AramoError('VALIDATION_ERROR', 'This draft was saved in another session. Reload it.', 409, {
        requestId,
        details: { id: intake.id, reason: 'save_conflict' },
      });
    }
    // Carry the winner's progress so step 1 is not re-attempted needlessly.
    intake.save_reserved_talent_record_id = reserved;
    intake.save_evidence_materialized_at = reread.save_evidence_materialized_at ?? null;
    intake.save_evidence_payload_hash = reread.save_evidence_payload_hash ?? null;
    return reserved;
  }

  private async artifactSha(
    intake: TalentIntakeDraftRow,
    storageKey: string,
    requestId: string,
  ): Promise<string | undefined> {
    if (intake.artifact_sha256 !== null && intake.artifact_sha256 !== '') {
      return intake.artifact_sha256;
    }
    try {
      const hashed = await this.resumeParser?.computeArtifactSha256FromStorageKey?.({
        storage_key: storageKey,
        requestId,
      });
      return hashed?.artifact_sha256;
    } catch {
      return undefined;
    }
  }

  // Construct the canonical create input from the PERSISTED review payload.
  // Recruiter-reviewed values are the source of truth — on the governed AND the
  // extraction-decoupled draft alike (the extraction child only contributes the
  // link it is ACCEPTED under at step 1).
  private buildCreateInput(intake: TalentIntakeDraftRow): CreateTalentRecordRequestDto {
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
      // Admission anchors (default to '' so the missing-field guard reports them
      // precisely).
      first_name: str('first_name') ?? '',
      last_name: str('last_name') ?? '',
      email1: str('email1') ?? '',
      phone_cell: str('phone_cell') ?? '',
      // Every other recruiter-reviewed scalar the create contract accepts — carried
      // through so no persisted edit is lost. Undefined keys are dropped below.
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
      // resume_document is attached ONLY for artifact-backed sources. A
      // non-upload source (ADR-0033 §5, storage_key null) saves with no résumé
      // document.
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
