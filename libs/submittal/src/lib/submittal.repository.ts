import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError, type AramoLogger } from '@aramo/common';
import { EvidenceRepository } from '@aramo/evidence';
import { ExaminationRepository } from '@aramo/examination';
import { recordUsage } from '@aramo/metering';

import type { RecruiterAttestationsDto } from './dto/confirm-submittal-request.dto.js';
import type { TalentSubmittalEventView } from './dto/talent-submittal-event.view.js';
import type {
  CreateSubmittalInput,
  FailedCriterionAcknowledgment,
  TalentSubmittalRecordView,
} from './dto/talent-submittal-record.view.js';
import { PrismaService } from './prisma/prisma.service.js';
import { canTransition, type SubmittalStateValue } from './submittal-state.js';
import { TalentSubmittalEventRepository } from './talent-submittal-event.repository.js';

// SubmittalRepository — M4 PR-3 §4.3 + M5 PR-8b2 §4.7.
//
// Owns the write path for TalentSubmittalRecord and orchestrates the
// cross-schema build of the immutable TalentJobEvidencePackage via PR-2's
// EvidenceRepository.buildPackage. The orchestration is repository-layer
// (not a service layer) per PR-2's Ruling 2 precedent — minimal
// orchestration belongs in the repository.
//
// M5 PR-8b2 surface extensions (canonical 5-state machine rename +
// cutover; F37 closure):
//   - 3 new write methods (markReady, submitToAts, confirmAts) covering
//     the 3 net-new mainline transitions per Q5 PATTERN-b.
//   - confirmSubmittal semantic update per Ruling 12: M4's 'draft to
//     submitted' becomes canonical 'created to handoff_draft'.
//     confirmed_at NO LONGER populated here (moved to submitToAts per
//     Ruling 6 — preserves M4 confirmed_at column semantic at the
//     ready_for_review to submitted_to_ats transition).
//   - revokeSubmittal semantic expansion per Q3 ruling: revocable from
//     any non-confirmed non-revoked state (Ruling 5 — `confirmed` is
//     terminal). Now spans created / handoff_draft / ready_for_review /
//     submitted_to_ats.
//   - canTransition guard wired into all 5 state-changing methods as
//     defense-in-depth atop the DB trigger.
//   - SubmittalEventRepository.appendEvent wired into all 5 state-
//     changing methods (createSubmittal stays event-free per Ruling 15).
//
// Surface (closed):
//   - createSubmittal (M4 PR-3 — UNCHANGED per Ruling 15; no event)
//   - confirmSubmittal (M4 PR-4 + rename; state created -> handoff_draft)
//   - markReady (M5 PR-8b2; state handoff_draft -> ready_for_review)
//   - submitToAts (M5 PR-8b2; state ready_for_review -> submitted_to_ats
//     + confirmed_at populated)
//   - confirmAts (M5 PR-8b2; state submitted_to_ats -> confirmed)
//   - revokeSubmittal (M4 PR-7 + Q3 expansion; any non-terminal -> revoked)
//   - findById / findByTenantAndEvidencePackage (READ; tenant-scoped)
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

interface TalentSubmittalEventRow {
  id: string;
  tenant_id: string;
  submittal_id: string;
  event_type: 'state_transition';
  event_payload: unknown;
  created_at: Date;
}

function projectEventView(row: TalentSubmittalEventRow): TalentSubmittalEventView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    submittal_id: row.submittal_id,
    event_type: row.event_type,
    event_payload: row.event_payload,
    created_at: row.created_at,
  };
}

// ConfirmSubmittalInput — M4 PR-4 confirm input. event_id added at PR-8b2
// per Ruling 18 (controller mints UUID; mirrors engagement-side
// transitionState pattern at libs/engagement/src/lib/engagement
// .repository.ts).
export interface ConfirmSubmittalInput {
  tenant_id: string;
  submittal_id: string;
  attestations: RecruiterAttestationsDto;
  event_id: string;
  requestId: string;
}

// M4 PR-7 revoke input + PR-8b2 event_id.
export interface RevokeSubmittalInput {
  tenant_id: string;
  submittal_id: string;
  revoked_by: string;
  revocation_justification: string;
  event_id: string;
  requestId: string;
}

// M5 PR-8b2 §4.7 — 3 new repository-layer input shapes (workspace-unique
// names per Process Lesson 53 + Lead-Q-PR-8b2-A7 defensive prefix).
export interface SubmittalMarkReadyInput {
  tenant_id: string;
  submittal_id: string;
  event_id: string;
  requestId: string;
}

export interface SubmittalSubmitToAtsInput {
  tenant_id: string;
  submittal_id: string;
  event_id: string;
  requestId: string;
}

export interface SubmittalConfirmAtsInput {
  tenant_id: string;
  submittal_id: string;
  event_id: string;
  requestId: string;
}

// M5 PR-8b2 §4.7 — 3 new repository-layer result shapes (each carries
// the updated submittal projection + the freshly appended event view).
export interface SubmittalMarkReadyResult {
  submittal: TalentSubmittalRecordView;
  event: TalentSubmittalEventView;
}

export interface SubmittalSubmitToAtsResult {
  submittal: TalentSubmittalRecordView;
  event: TalentSubmittalEventView;
}

export interface SubmittalConfirmAtsResult {
  submittal: TalentSubmittalRecordView;
  event: TalentSubmittalEventView;
}

@Injectable()
export class SubmittalRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly evidenceRepository: EvidenceRepository,
    private readonly examinationRepository: ExaminationRepository,
    // M4 PR-9 §4.5 — structured logger injected via DI.
    @Inject('SubmittalRepositoryLogger')
    private readonly logger: AramoLogger,
    // M5 PR-8b2 §4.7 + Ruling 17 — 5th DI dependency: append-only event
    // log substrate (PR-8b1 shipped the repository; PR-8b2 wires it
    // into all 5 state-changing write methods). Per engagement-side
    // transitionState precedent, the write-path event emission goes
    // through this.prisma.talentSubmittalEvent.create directly inside
    // the $transaction block (atomicity requirement); the injection
    // here exists for DI surface visibility + future read-path
    // consumer additions (e.g., findByTenantAndSubmittalId reads from
    // controller GET endpoints).
    private readonly eventRepository: TalentSubmittalEventRepository,
  ) {
    void this.eventRepository;
  }

  async createSubmittal(
    input: CreateSubmittalInput,
  ): Promise<TalentSubmittalRecordView> {
    const startedAt = Date.now();

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

    await this.evidenceRepository.buildPackage({
      id: evidencePackageId,
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
      job_id: input.job_id,
      examination_id: input.examination_id,
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

    // M5 PR-8b2 §4.7 + Ruling 12 — initial state is canonical 'created'
    // (renamed from M4 'draft'). Per Ruling 15 createSubmittal does NOT
    // emit a state_transition event (the table FK forbids events for
    // non-existent submittals; the first event happens at the first
    // transition out of 'created').
    const dataPayload: Record<string, unknown> = {
      id: submittalId,
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
      job_id: input.job_id,
      evidence_package_id: evidencePackageId,
      pinned_examination_id: input.examination_id,
      state: 'created',
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

  // M4 PR-4 confirm flow + M5 PR-8b2 rename + cutover.
  //
  // Per Ruling 12: M4 /confirm endpoint semantic becomes canonical
  // 'created -> handoff_draft' (preserving M4 user intent: recruiter
  // finalizes draft submittal entry; lifecycle progresses). The heavy
  // M4 enforcement logic (3 attestations + pinned-examination revalidation
  // + Worth Considering tier check + justification/ack requirement)
  // remains appropriate at this transition per Ruling 24 (examination-
  // pinning reaffirmation): the recruiter MUST still re-affirm pin
  // validity at confirm-time.
  //
  // Per Ruling 6: confirmed_at NO LONGER populated here (moved to
  // submitToAts at the ready_for_review -> submitted_to_ats transition).
  // Preserves M4 confirmed_at column semantic + name.
  //
  // M5 PR-8b2 §4.7 additions:
  //   - canTransition guard before the SQL UPDATE (defense-in-depth atop
  //     the DB trigger) -> SUBMITTAL_STATE_INVALID 422.
  //   - SUBMITTAL_ALREADY_CONFIRMED check preserved (M4 client error
  //     vocabulary for double-call case): if state is 'handoff_draft'
  //     return ALREADY_CONFIRMED 409 (preserves M4 caller's expectation
  //     that re-calling /confirm on a confirmed submittal returns 409
  //     not 422).
  //   - $transaction([update, event.create]) for atomic 2-write per
  //     engagement-side transitionState precedent.
  async confirmSubmittal(
    input: ConfirmSubmittalInput,
  ): Promise<{ submittal: TalentSubmittalRecordView; event: TalentSubmittalEventView }> {
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

    // Step 2 — M4 client-vocabulary preservation: if state is 'handoff_draft'
    // (the post-rename equivalent of M4 'submitted' confirm-target),
    // surface SUBMITTAL_ALREADY_CONFIRMED 409 so M4 callers see the
    // expected error code on double-call.
    if (submittal.state === 'handoff_draft') {
      this.logger.log({
        event: 'submittal_confirm_refused',
        tenant_id: input.tenant_id,
        submittal_id: input.submittal_id,
        code: 'SUBMITTAL_ALREADY_CONFIRMED',
      });
      throw new AramoError(
        'SUBMITTAL_ALREADY_CONFIRMED',
        'Submittal is already in handoff_draft state',
        409,
        {
          requestId: input.requestId,
          details: { submittal_id: input.submittal_id, state: submittal.state },
        },
      );
    }

    // Step 2b — M5 PR-8b2 canTransition guard for OTHER invalid from-states
    // (ready_for_review / submitted_to_ats / confirmed / revoked).
    if (!canTransition(submittal.state, 'handoff_draft')) {
      this.logger.log({
        event: 'submittal_confirm_refused',
        tenant_id: input.tenant_id,
        submittal_id: input.submittal_id,
        code: 'SUBMITTAL_STATE_INVALID',
        from_state: submittal.state,
        to_state: 'handoff_draft',
      });
      throw new AramoError(
        'SUBMITTAL_STATE_INVALID',
        `Illegal submittal state transition: ${submittal.state} -> handoff_draft`,
        422,
        {
          requestId: input.requestId,
          details: {
            submittal_id: input.submittal_id,
            from_state: submittal.state,
            to_state: 'handoff_draft',
          },
        },
      );
    }

    // Step 3 — pinned examination Full view (gives tier + lifecycle_state).
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

    // Step 6 — newest-examination check (Ruling 24 pin-reaffirmation).
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

    void input.attestations;

    // Step 8 — atomic 3-write transaction (update + event.create + outbox)
    // per engagement-side precedent. Per Ruling 12 the transition is
    // 'created' -> 'handoff_draft'; per Ruling 6 confirmed_at is NOT
    // touched here (moves to submitToAts). M6 PR-2 §3 adds the in-tx
    // outbox emission; rollback leaves no orphan outbox row (Cat 5 proof).
    const [updatedRow, eventRow] = await this.prisma.$transaction([
      this.prisma.talentSubmittalRecord.update({
        where: { id: input.submittal_id, tenant_id: input.tenant_id },
        data: { state: 'handoff_draft' },
      }),
      this.prisma.talentSubmittalEvent.create({
        data: {
          id: input.event_id,
          tenant_id: input.tenant_id,
          submittal_id: input.submittal_id,
          event_type: 'state_transition',
          event_payload: {
            from_state: submittal.state,
            to_state: 'handoff_draft',
          } as never,
        },
      }),
      this.prisma.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: 'submittal.state_transition',
          event_payload: {
            submittal_id: input.submittal_id,
            tenant_id: input.tenant_id,
            from_state: submittal.state,
            to_state: 'handoff_draft',
            transition_event_id: input.event_id,
          } as never,
        },
      }),
      // PR-A1c — in-tx metered usage event (Ruling 6 same-transaction).
      recordUsage(this.prisma, {
        tenant_id: input.tenant_id,
        event_type: 'submittal.state_transition',
      }),
    ]);

    const submittalView = projectView(updatedRow as TalentSubmittalRecordRow);
    const eventView = projectEventView(eventRow as TalentSubmittalEventRow);
    this.logger.log({
      event: 'submittal_confirmed',
      tenant_id: submittalView.tenant_id,
      submittal_id: submittalView.id,
      submittal_event_id: eventView.id,
      from_state: submittal.state,
      to_state: submittalView.state,
      pinned_examination_id: submittalView.pinned_examination_id,
      latency_ms: Date.now() - startedAt,
    });
    return { submittal: submittalView, event: eventView };
  }

  // M5 PR-8b2 §4.7 — markReady. Mainline transition 2:
  // handoff_draft -> ready_for_review. 5-step internal flow per
  // directive §4.7: findByTenantAndId -> canTransition -> $transaction
  // -> project + return -> log. Mirrors engagement-side transitionState
  // shape verbatim.
  async markReady(input: SubmittalMarkReadyInput): Promise<SubmittalMarkReadyResult> {
    const startedAt = Date.now();
    this.logger.log({
      event: 'submittal_mark_ready_started',
      tenant_id: input.tenant_id,
      submittal_id: input.submittal_id,
    });

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

    if (!canTransition(submittal.state, 'ready_for_review')) {
      this.logger.log({
        event: 'submittal_mark_ready_refused',
        tenant_id: input.tenant_id,
        submittal_id: input.submittal_id,
        code: 'SUBMITTAL_STATE_INVALID',
        from_state: submittal.state,
        to_state: 'ready_for_review',
      });
      throw new AramoError(
        'SUBMITTAL_STATE_INVALID',
        `Illegal submittal state transition: ${submittal.state} -> ready_for_review`,
        422,
        {
          requestId: input.requestId,
          details: {
            submittal_id: input.submittal_id,
            from_state: submittal.state,
            to_state: 'ready_for_review',
          },
        },
      );
    }

    // M6 PR-2 §3 — atomic 3-write (update + event.create + outbox).
    const [updatedRow, eventRow] = await this.prisma.$transaction([
      this.prisma.talentSubmittalRecord.update({
        where: { id: input.submittal_id, tenant_id: input.tenant_id },
        data: { state: 'ready_for_review' },
      }),
      this.prisma.talentSubmittalEvent.create({
        data: {
          id: input.event_id,
          tenant_id: input.tenant_id,
          submittal_id: input.submittal_id,
          event_type: 'state_transition',
          event_payload: {
            from_state: submittal.state,
            to_state: 'ready_for_review',
          } as never,
        },
      }),
      this.prisma.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: 'submittal.state_transition',
          event_payload: {
            submittal_id: input.submittal_id,
            tenant_id: input.tenant_id,
            from_state: submittal.state,
            to_state: 'ready_for_review',
            transition_event_id: input.event_id,
          } as never,
        },
      }),
      // PR-A1c — in-tx metered usage event (Ruling 6 same-transaction).
      recordUsage(this.prisma, {
        tenant_id: input.tenant_id,
        event_type: 'submittal.state_transition',
      }),
    ]);

    const submittalView = projectView(updatedRow as TalentSubmittalRecordRow);
    const eventView = projectEventView(eventRow as TalentSubmittalEventRow);
    this.logger.log({
      event: 'submittal_marked_ready',
      tenant_id: submittalView.tenant_id,
      submittal_id: submittalView.id,
      submittal_event_id: eventView.id,
      from_state: submittal.state,
      to_state: submittalView.state,
      latency_ms: Date.now() - startedAt,
    });
    return { submittal: submittalView, event: eventView };
  }

  // M5 PR-8b2 §4.7 — submitToAts. Mainline transition 3:
  // ready_for_review -> submitted_to_ats. Per Ruling 6 this transition
  // populates confirmed_at (NULL -> non-NULL); preserves M4 confirmed_at
  // column semantic post-rename.
  async submitToAts(input: SubmittalSubmitToAtsInput): Promise<SubmittalSubmitToAtsResult> {
    const startedAt = Date.now();
    this.logger.log({
      event: 'submittal_submit_to_ats_started',
      tenant_id: input.tenant_id,
      submittal_id: input.submittal_id,
    });

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

    if (!canTransition(submittal.state, 'submitted_to_ats')) {
      this.logger.log({
        event: 'submittal_submit_to_ats_refused',
        tenant_id: input.tenant_id,
        submittal_id: input.submittal_id,
        code: 'SUBMITTAL_STATE_INVALID',
        from_state: submittal.state,
        to_state: 'submitted_to_ats',
      });
      throw new AramoError(
        'SUBMITTAL_STATE_INVALID',
        `Illegal submittal state transition: ${submittal.state} -> submitted_to_ats`,
        422,
        {
          requestId: input.requestId,
          details: {
            submittal_id: input.submittal_id,
            from_state: submittal.state,
            to_state: 'submitted_to_ats',
          },
        },
      );
    }

    // M6 PR-2 §3 — atomic 3-write (update + event.create + outbox).
    const [updatedRow, eventRow] = await this.prisma.$transaction([
      this.prisma.talentSubmittalRecord.update({
        where: { id: input.submittal_id, tenant_id: input.tenant_id },
        data: { state: 'submitted_to_ats', confirmed_at: new Date() },
      }),
      this.prisma.talentSubmittalEvent.create({
        data: {
          id: input.event_id,
          tenant_id: input.tenant_id,
          submittal_id: input.submittal_id,
          event_type: 'state_transition',
          event_payload: {
            from_state: submittal.state,
            to_state: 'submitted_to_ats',
          } as never,
        },
      }),
      this.prisma.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: 'submittal.state_transition',
          event_payload: {
            submittal_id: input.submittal_id,
            tenant_id: input.tenant_id,
            from_state: submittal.state,
            to_state: 'submitted_to_ats',
            transition_event_id: input.event_id,
          } as never,
        },
      }),
      // PR-A1c — in-tx metered usage event (Ruling 6 same-transaction).
      recordUsage(this.prisma, {
        tenant_id: input.tenant_id,
        event_type: 'submittal.state_transition',
      }),
    ]);

    const submittalView = projectView(updatedRow as TalentSubmittalRecordRow);
    const eventView = projectEventView(eventRow as TalentSubmittalEventRow);
    this.logger.log({
      event: 'submittal_submitted_to_ats',
      tenant_id: submittalView.tenant_id,
      submittal_id: submittalView.id,
      submittal_event_id: eventView.id,
      from_state: submittal.state,
      to_state: submittalView.state,
      latency_ms: Date.now() - startedAt,
    });
    return { submittal: submittalView, event: eventView };
  }

  // M5 PR-8b2 §4.7 — confirmAts. Mainline transition 4:
  // submitted_to_ats -> confirmed. `confirmed` is lifecycle-terminal
  // (Ruling 5 — not even sibling-revoke applies; ATS confirmation
  // closes the workflow).
  async confirmAts(input: SubmittalConfirmAtsInput): Promise<SubmittalConfirmAtsResult> {
    const startedAt = Date.now();
    this.logger.log({
      event: 'submittal_confirm_ats_started',
      tenant_id: input.tenant_id,
      submittal_id: input.submittal_id,
    });

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

    if (!canTransition(submittal.state, 'confirmed')) {
      this.logger.log({
        event: 'submittal_confirm_ats_refused',
        tenant_id: input.tenant_id,
        submittal_id: input.submittal_id,
        code: 'SUBMITTAL_STATE_INVALID',
        from_state: submittal.state,
        to_state: 'confirmed',
      });
      throw new AramoError(
        'SUBMITTAL_STATE_INVALID',
        `Illegal submittal state transition: ${submittal.state} -> confirmed`,
        422,
        {
          requestId: input.requestId,
          details: {
            submittal_id: input.submittal_id,
            from_state: submittal.state,
            to_state: 'confirmed',
          },
        },
      );
    }

    // M6 PR-2 §3 — atomic 3-write (update + event.create + outbox).
    const [updatedRow, eventRow] = await this.prisma.$transaction([
      this.prisma.talentSubmittalRecord.update({
        where: { id: input.submittal_id, tenant_id: input.tenant_id },
        data: { state: 'confirmed' },
      }),
      this.prisma.talentSubmittalEvent.create({
        data: {
          id: input.event_id,
          tenant_id: input.tenant_id,
          submittal_id: input.submittal_id,
          event_type: 'state_transition',
          event_payload: {
            from_state: submittal.state,
            to_state: 'confirmed',
          } as never,
        },
      }),
      this.prisma.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: 'submittal.state_transition',
          event_payload: {
            submittal_id: input.submittal_id,
            tenant_id: input.tenant_id,
            from_state: submittal.state,
            to_state: 'confirmed',
            transition_event_id: input.event_id,
          } as never,
        },
      }),
      // PR-A1c — in-tx metered usage event (Ruling 6 same-transaction).
      recordUsage(this.prisma, {
        tenant_id: input.tenant_id,
        event_type: 'submittal.state_transition',
      }),
    ]);

    const submittalView = projectView(updatedRow as TalentSubmittalRecordRow);
    const eventView = projectEventView(eventRow as TalentSubmittalEventRow);
    this.logger.log({
      event: 'submittal_confirmed_ats',
      tenant_id: submittalView.tenant_id,
      submittal_id: submittalView.id,
      submittal_event_id: eventView.id,
      from_state: submittal.state,
      to_state: submittalView.state,
      latency_ms: Date.now() - startedAt,
    });
    return { submittal: submittalView, event: eventView };
  }

  // M4 PR-7 revoke flow + M5 PR-8b2 Q3 expansion.
  //
  // Per Q3 + Ruling 5: revoke applicable from any non-terminal state
  // (`created`, `handoff_draft`, `ready_for_review`, `submitted_to_ats`).
  // NOT applicable from `confirmed` (terminal — ATS confirmation closes
  // workflow) or `revoked` (already revoked). canTransition is the
  // gatekeeping guard; REVOKE_NOT_ALLOWED 422 fires on terminal-state
  // refusals (preserves M4 error vocabulary).
  //
  // Per M5 PR-8b2 §4.7: appendEvent wired via $transaction (atomic
  // 2-write). Write-isolation contract preserved: the referenced
  // evidence-package row is NEVER read or written by this method.
  async revokeSubmittal(
    input: RevokeSubmittalInput,
  ): Promise<{ submittal: TalentSubmittalRecordView; event: TalentSubmittalEventView }> {
    const startedAt = Date.now();
    this.logger.log({
      event: 'submittal_revoke_started',
      tenant_id: input.tenant_id,
      submittal_id: input.submittal_id,
    });

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

    // Q3 + Ruling 5: revoke refused from terminal states (confirmed +
    // revoked). canTransition('confirmed', 'revoked') and
    // canTransition('revoked', 'revoked') both return false.
    if (!canTransition(submittal.state, 'revoked')) {
      this.logger.log({
        event: 'submittal_revoke_refused',
        tenant_id: input.tenant_id,
        submittal_id: input.submittal_id,
        code: 'REVOKE_NOT_ALLOWED',
        current_state: submittal.state,
      });
      throw new AramoError(
        'REVOKE_NOT_ALLOWED',
        `Submittal in state ${submittal.state} cannot be revoked; terminal states (confirmed, revoked) are not revocable`,
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

    // Atomic 3-write transaction (update + event.create + outbox). state
    // moves to 'revoked'; revoked_at / revoked_by / revocation_justification
    // populate together (DB trigger sibling-revoke branch enforces).
    // M6 PR-2 §3 adds the in-tx outbox emission. NO call to
    // prisma.talentJobEvidencePackage.* anywhere.
    const [updatedRow, eventRow] = await this.prisma.$transaction([
      this.prisma.talentSubmittalRecord.update({
        where: { id: input.submittal_id, tenant_id: input.tenant_id },
        data: {
          state: 'revoked',
          revoked_at: new Date(),
          revoked_by: input.revoked_by,
          revocation_justification: input.revocation_justification,
        },
      }),
      this.prisma.talentSubmittalEvent.create({
        data: {
          id: input.event_id,
          tenant_id: input.tenant_id,
          submittal_id: input.submittal_id,
          event_type: 'state_transition',
          event_payload: {
            from_state: submittal.state,
            to_state: 'revoked',
          } as never,
        },
      }),
      this.prisma.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: 'submittal.state_transition',
          event_payload: {
            submittal_id: input.submittal_id,
            tenant_id: input.tenant_id,
            from_state: submittal.state,
            to_state: 'revoked',
            transition_event_id: input.event_id,
          } as never,
        },
      }),
      // PR-A1c — in-tx metered usage event (Ruling 6 same-transaction).
      recordUsage(this.prisma, {
        tenant_id: input.tenant_id,
        event_type: 'submittal.state_transition',
      }),
    ]);

    const submittalView = projectView(updatedRow as TalentSubmittalRecordRow);
    const eventView = projectEventView(eventRow as TalentSubmittalEventRow);

    this.logger.log({
      event: 'submittal_revoked',
      tenant_id: submittalView.tenant_id,
      submittal_id: submittalView.id,
      submittal_event_id: eventView.id,
      from_state: submittal.state,
      to_state: submittalView.state,
      revoked_by: submittalView.revoked_by,
      latency_ms: Date.now() - startedAt,
    });

    return { submittal: submittalView, event: eventView };
  }
}
