import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';
import { EvidenceRepository } from '@aramo/evidence';
import { ExaminationRepository } from '@aramo/examination';

import type { RecruiterAttestationsDto } from './dto/confirm-submittal-request.dto.js';
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
  // M4 PR-7 — revoke metadata. Nullable until the submittal-revoke
  // endpoint atomically transitions submitted→revoked.
  revoked_at: Date | null;
  revoked_by: string | null;
  revocation_justification: string | null;
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
    revoked_at: row.revoked_at,
    revoked_by: row.revoked_by,
    revocation_justification: row.revocation_justification,
  };
}

// ConfirmSubmittalInput — repository-layer input for the M4 PR-4 confirm
// flow. tenant_id flows from JWT auth context; submittal_id from the
// request path; attestations from the body; requestId from the HTTP
// boundary's RequestId decorator (threaded into each AramoError envelope
// so the response carries the correct request_id field).
export interface ConfirmSubmittalInput {
  tenant_id: string;
  submittal_id: string;
  attestations: RecruiterAttestationsDto;
  requestId: string;
}

// M4 PR-7 §4.3 — repository-layer input for the submittal-revoke flow.
//   - tenant_id: JWT-derived; required for tenant-scoped findById.
//   - submittal_id: HTTP path param.
//   - revoked_by: UUID of the recruiter actor performing the revoke
//     (derived from JWT sub at the controller boundary).
//   - revocation_justification: recruiter-authored rationale.
//   - requestId: bound into each AramoError envelope so the response
//     surfaces the correct request_id.
export interface RevokeSubmittalInput {
  tenant_id: string;
  submittal_id: string;
  revoked_by: string;
  revocation_justification: string;
  requestId: string;
}

@Injectable()
export class SubmittalRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly evidenceRepository: EvidenceRepository,
    private readonly examinationRepository: ExaminationRepository,
    // M4 PR-9 §4.5 — structured logger injected via DI. Provider lives
    // in SubmittalModule keyed by the 'SubmittalRepositoryLogger' token;
    // factory context is SubmittalRepository.name.
    @Inject('SubmittalRepositoryLogger')
    private readonly logger: AramoLogger,
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

  // M4 PR-4 §4.2 — confirm flow.
  //
  // Re-validates the pinned examination + 3 recruiter attestations + tier/
  // justification preconditions, then flips state 'draft' → 'submitted'
  // and stamps confirmed_at. The PR-3 column-scoped trigger
  // (talent_submittal_record_engagement_audit) only permits this exact
  // transition; the trigger is the second belt, the steps below are the
  // first.
  //
  // Eight ordered steps (each raises AramoError with input.requestId
  // bound into the envelope so the response's request_id is correct):
  //   (1) findById tenant-scoped — null → NOT_FOUND 404
  //   (2) state already 'submitted' → SUBMITTAL_ALREADY_CONFIRMED 409
  //   (3) examinationRepository.findByIdFull(pinned_examination_id) →
  //       null → EXAMINATION_PINNED_OUTDATED 409
  //   (4) examinationFull.lifecycle_state !== 'active' →
  //       EXAMINATION_PINNED_OUTDATED 409
  //   (5) examinationFull.tier === 'STRETCH' → SUBMITTAL_STRETCH_BLOCKED 422
  //       (re-check of PR-2's create-time gate — a Stretch row could only
  //       reach this path if the create-time gate is bypassed by direct
  //       SQL, but the confirm endpoint is the last line of defense)
  //   (6) findLatestByTenantTalentJob → null or id mismatch →
  //       EXAMINATION_PINNED_OUTDATED 409 (a newer snapshot exists; the
  //       recruiter must refresh the draft and re-pin)
  //   (7) tier === 'WORTH_CONSIDERING' → require justification (non-empty
  //       after trim) AND failed_criterion_acknowledgments (>=1 entry).
  //       Missing either → JUSTIFICATION_REQUIRED 422.
  //   (8) prisma UPDATE with tenant_id + id filter, setting state and
  //       confirmed_at. The trigger validates the transition.
  //
  // Attestations are checked at the controller boundary (not here) per
  // directive §4.3 step 4 — the controller's manual 3-line check throws
  // ATTESTATION_MISSING 422 before reaching the repository.
  async confirmSubmittal(
    input: ConfirmSubmittalInput,
  ): Promise<TalentSubmittalRecordView> {
    const startedAt = Date.now();
    this.logger.log({
      event: 'submittal_confirm_started',
      tenant_id: input.tenant_id,
      submittal_id: input.submittal_id,
    });

    // Step 1 — load tenant-scoped.
    const submittal = await this.findById({
      tenant_id: input.tenant_id,
      id: input.submittal_id,
    });
    if (submittal === null) {
      throw new AramoError(
        'NOT_FOUND',
        'TalentSubmittalRecord not found',
        404,
        {
          requestId: input.requestId,
          details: { submittal_id: input.submittal_id },
        },
      );
    }

    // Step 2 — already submitted (the column-scoped trigger would block
    // a second draft→submitted attempt, but we surface the dedicated
    // SUBMITTAL_ALREADY_CONFIRMED 409 code/status pair instead of letting
    // the trigger's generic message flow back).
    if (submittal.state === 'submitted') {
      this.logger.log({
        event: 'submittal_confirm_refused',
        tenant_id: input.tenant_id,
        submittal_id: input.submittal_id,
        code: 'SUBMITTAL_ALREADY_CONFIRMED',
      });
      throw new AramoError(
        'SUBMITTAL_ALREADY_CONFIRMED',
        'Submittal is already in submitted state',
        409,
        {
          requestId: input.requestId,
          details: { submittal_id: input.submittal_id, state: submittal.state },
        },
      );
    }

    // Step 3 — pinned examination Full view (gives tier + lifecycle_state
    // typed at the projection boundary).
    const examinationFull = await this.examinationRepository.findByIdFull(
      submittal.pinned_examination_id,
    );
    if (examinationFull === null) {
      this.logger.log({
        event: 'submittal_confirm_refused',
        tenant_id: input.tenant_id,
        submittal_id: input.submittal_id,
        code: 'EXAMINATION_PINNED_OUTDATED',
        reason: 'pinned_examination_missing',
      });
      throw new AramoError(
        'EXAMINATION_PINNED_OUTDATED',
        'Pinned examination no longer exists',
        409,
        {
          requestId: input.requestId,
          details: {
            submittal_id: input.submittal_id,
            pinned_examination_id: submittal.pinned_examination_id,
          },
        },
      );
    }

    // Step 4 — pinned lifecycle no longer active.
    if (examinationFull.lifecycle_state !== 'active') {
      this.logger.log({
        event: 'submittal_confirm_refused',
        tenant_id: input.tenant_id,
        submittal_id: input.submittal_id,
        code: 'EXAMINATION_PINNED_OUTDATED',
        reason: 'pinned_examination_inactive',
        lifecycle_state: examinationFull.lifecycle_state,
      });
      throw new AramoError(
        'EXAMINATION_PINNED_OUTDATED',
        `Pinned examination lifecycle_state is ${examinationFull.lifecycle_state}`,
        409,
        {
          requestId: input.requestId,
          details: {
            submittal_id: input.submittal_id,
            pinned_examination_id: submittal.pinned_examination_id,
            lifecycle_state: examinationFull.lifecycle_state,
          },
        },
      );
    }

    // Step 5 — Stretch tier re-check (R9 substrate-layer defense).
    if (examinationFull.tier === 'STRETCH') {
      this.logger.log({
        event: 'submittal_confirm_refused',
        tenant_id: input.tenant_id,
        submittal_id: input.submittal_id,
        code: 'SUBMITTAL_STRETCH_BLOCKED',
      });
      throw new AramoError(
        'SUBMITTAL_STRETCH_BLOCKED',
        'Stretch-tier examinations cannot be confirmed',
        422,
        {
          requestId: input.requestId,
          details: {
            submittal_id: input.submittal_id,
            pinned_examination_id: submittal.pinned_examination_id,
            tier: examinationFull.tier,
          },
        },
      );
    }

    // Step 6 — newest-examination check. If the latest active row for
    // (tenant, talent, job) is not the pinned row, the recruiter is
    // confirming against a stale draft and must refresh.
    const latest = await this.examinationRepository.findLatestByTenantTalentJob({
      tenant_id: input.tenant_id,
      talent_id: submittal.talent_id,
      job_id: submittal.job_id,
    });
    if (latest === null || latest.id !== submittal.pinned_examination_id) {
      this.logger.log({
        event: 'submittal_confirm_refused',
        tenant_id: input.tenant_id,
        submittal_id: input.submittal_id,
        code: 'EXAMINATION_PINNED_OUTDATED',
        reason: 'newer_examination_exists',
        pinned_examination_id: submittal.pinned_examination_id,
        latest_examination_id: latest?.id ?? null,
      });
      throw new AramoError(
        'EXAMINATION_PINNED_OUTDATED',
        'Newer examination exists; recruiter must refresh draft',
        409,
        {
          requestId: input.requestId,
          details: {
            submittal_id: input.submittal_id,
            pinned_examination_id: submittal.pinned_examination_id,
            latest_examination_id: latest?.id ?? null,
          },
        },
      );
    }

    // Step 7 — Worth Considering enforcement.
    if (examinationFull.tier === 'WORTH_CONSIDERING') {
      const justification = submittal.justification;
      if (justification === null || justification.trim() === '') {
        this.logger.log({
          event: 'submittal_confirm_refused',
          tenant_id: input.tenant_id,
          submittal_id: input.submittal_id,
          code: 'JUSTIFICATION_REQUIRED',
          reason: 'justification_missing',
        });
        throw new AramoError(
          'JUSTIFICATION_REQUIRED',
          'Worth Considering submittals require non-empty justification',
          422,
          {
            requestId: input.requestId,
            details: {
              submittal_id: input.submittal_id,
              missing_field: 'justification',
            },
          },
        );
      }
      const ack = submittal.failed_criterion_acknowledgments;
      if (ack === null || ack.length === 0) {
        this.logger.log({
          event: 'submittal_confirm_refused',
          tenant_id: input.tenant_id,
          submittal_id: input.submittal_id,
          code: 'JUSTIFICATION_REQUIRED',
          reason: 'failed_criterion_acknowledgments_missing',
        });
        throw new AramoError(
          'JUSTIFICATION_REQUIRED',
          'Worth Considering submittals require failed_criterion_acknowledgments',
          422,
          {
            requestId: input.requestId,
            details: {
              submittal_id: input.submittal_id,
              missing_field: 'failed_criterion_acknowledgments',
            },
          },
        );
      }
    }

    // Suppress unused-attestations warning — the attestations are
    // enforced at the controller boundary before this method is invoked;
    // they are accepted into the input shape for forward compatibility
    // (logging, audit-event emission in M5) but consumed nowhere in this
    // method. Reference the value once so TypeScript's noUnusedParameters
    // is satisfied without changing the input shape.
    void input.attestations;

    // Step 8 — flip state to 'submitted' with confirmed_at stamp. The
    // column-scoped trigger validates the transition; only state +
    // confirmed_at are touched here so the trigger's allowlist passes.
    const updated = await this.prisma.talentSubmittalRecord.update({
      where: { id: input.submittal_id, tenant_id: input.tenant_id },
      data: { state: 'submitted', confirmed_at: new Date() },
    });

    const view = projectView(updated as TalentSubmittalRecordRow);
    this.logger.log({
      event: 'submittal_confirmed',
      tenant_id: view.tenant_id,
      submittal_id: view.id,
      pinned_examination_id: view.pinned_examination_id,
      latency_ms: Date.now() - startedAt,
    });
    return view;
  }

  // M4 PR-7 §4.3 — revoke flow.
  //
  // Transitions a TalentSubmittalRecord from 'submitted' to 'revoked'
  // and stamps revoked_at / revoked_by / revocation_justification
  // atomically. The Transition B branch in the column-scoped trigger
  // (engagement.reject_submittal_record_update, PR-7 migration) is the
  // substrate-layer enforcement; this method is the first line of
  // defense.
  //
  // WRITE-ISOLATION CONTRACT (directive §4.3): this method touches
  // ONLY engagement.TalentSubmittalRecord via
  // prisma.talentSubmittalRecord.update. The referenced
  // evidence.TalentJobEvidencePackage row is NEVER read or written by
  // this method — the controller emits the literal
  // `evidence_package_mutated: false` in the response, and the Pact
  // provider state-isolation invariant (§4.9) verifies byte-identity
  // of the evidence-package row across every revoke interaction.
  //
  // Five ordered steps (each AramoError carries input.requestId so the
  // response envelope's request_id is correct):
  //   (1) findById tenant-scoped — null → NOT_FOUND 404.
  //   (2) state validation. Must be 'submitted'. Any other state
  //       ('draft', 'revoked') → REVOKE_NOT_ALLOWED 422 with
  //       current_state detail.
  //   (3) prisma.talentSubmittalRecord.update with tenant_id + id
  //       filter, setting state='revoked' and revoked_at/by/
  //       justification populated atomically. The trigger validates
  //       the transition.
  //   (4) structured logging at entry, refused, success.
  //   (5) project the updated row through projectView and return.
  async revokeSubmittal(
    input: RevokeSubmittalInput,
  ): Promise<TalentSubmittalRecordView> {
    const startedAt = Date.now();
    this.logger.log({
      event: 'submittal_revoke_started',
      tenant_id: input.tenant_id,
      submittal_id: input.submittal_id,
    });

    // Step 1 — tenant-scoped load.
    const submittal = await this.findById({
      tenant_id: input.tenant_id,
      id: input.submittal_id,
    });
    if (submittal === null) {
      throw new AramoError(
        'NOT_FOUND',
        'TalentSubmittalRecord not found',
        404,
        {
          requestId: input.requestId,
          details: { submittal_id: input.submittal_id },
        },
      );
    }

    // Step 2 — state validation. Only 'submitted' may be revoked.
    if (submittal.state !== 'submitted') {
      this.logger.log({
        event: 'submittal_revoke_refused',
        tenant_id: input.tenant_id,
        submittal_id: input.submittal_id,
        code: 'REVOKE_NOT_ALLOWED',
        current_state: submittal.state,
      });
      throw new AramoError(
        'REVOKE_NOT_ALLOWED',
        `Submittal in state ${submittal.state} cannot be revoked; only submitted submittals may be revoked`,
        422,
        {
          requestId: input.requestId,
          details: {
            submittal_id: input.submittal_id,
            current_state: submittal.state,
          },
        },
      );
    }

    // Step 3 — atomic UPDATE. state + revoked_at + revoked_by +
    // revocation_justification all move together; the column-scoped
    // trigger's Transition B branch validates the move. NO call to
    // prisma.talentJobEvidencePackage.* anywhere in this method.
    const updated = await this.prisma.talentSubmittalRecord.update({
      where: { id: input.submittal_id, tenant_id: input.tenant_id },
      data: {
        state: 'revoked',
        revoked_at: new Date(),
        revoked_by: input.revoked_by,
        revocation_justification: input.revocation_justification,
      },
    });

    const view = projectView(updated as TalentSubmittalRecordRow);

    // Step 4 — success log.
    this.logger.log({
      event: 'submittal_revoked',
      tenant_id: view.tenant_id,
      submittal_id: view.id,
      revoked_by: view.revoked_by,
      latency_ms: Date.now() - startedAt,
    });

    // Step 5 — return projected view.
    return view;
  }
}
