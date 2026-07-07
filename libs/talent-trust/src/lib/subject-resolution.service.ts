import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import {
  TalentTrustRepository,
  type SubjectMatchAdvisoryRow,
} from './talent-trust.repository.js';
import { TalentTrustService } from './talent-trust.service.js';

// SubjectResolutionService — TR-2a-3 ADVISORY RESOLUTION (the MERGE ACTION).
//
// Turns a PENDING_REVIEW same-human advisory (TR-2a-2) into an EXPLICIT, AUDITED
// human decision. THREE actions, all tenant-scoped and guarded:
//   - approveMerge — reviewer confirms same human → executes the EXISTING pointer-only
//     mergeSubjects (un-merge-safe) + records the merge on the advisory (→ MERGED).
//   - dismiss — reviewer judges NOT the same human → advisory (→ DISMISSED), no merge.
//   - reverseMerge — a prior MERGE is un-merged via the EXISTING unmergeSubjects
//     (both subjects restored to ACTIVE, merged_into cleared) → advisory (→ REVERSED).
//
// Invariants:
//   R1 NO AUTO-MERGE — every merge here is a human call on a PENDING_REVIEW advisory.
//   R2 MERGE+UN-MERGE SHIP TOGETHER — reverseMerge is the mandatory reversal.
//   R3 CONTRADICTION-GATED — merging a has_contradiction advisory REQUIRES an explicit
//      acknowledgment + a recorded justification (the F34 override); never silent.
//   R4 EVERY ACTION AUDITED — actor/time/action/justification land on the advisory
//      itself (the primary record; libs/audit is a stub with no event stream).
//   R5 LIFECYCLE + IDEMPOTENCY — can't re-resolve a resolved advisory; can't merge
//      already-merged subjects; a MERGED advisory can only be REVERSED.
//   R8 DETERMINISTIC — no LLM; pointer-only merge; talent_trust-internal (cip).
//
// TR-6 B2 (DDR D5 + PC Exit Accounting §5.1) — refusals throw AramoError with
// ADVISORY-SCOPE DOMAIN CODES (ADVISORY_NOT_PENDING / ADVISORY_NOT_MERGED /
// ADVISORY_NO_MERGED_SUBJECT / MERGE_SUBJECT_NOT_ACTIVE / CONTRADICTION_OVERRIDE_
// REQUIRED / REVERSAL_JUSTIFICATION_REQUIRED) instead of Nest exceptions that the
// AramoExceptionFilter status-collapsed to the semantically-false generic codes
// (409→IDEMPOTENCY_KEY_CONFLICT, 400→VALIDATION_ERROR). The filter is untouched —
// AramoError carries its own code, so the correct code reaches the wire. The
// caller threads its requestId (the AramoError envelope needs it).

export interface ApproveMergeInput {
  tenant_id: string;
  advisory_id: string;
  // The privileged actor (JWT sub) — recorded as resolved_by (R4).
  actor: string;
  // The request id (threaded from the controller) for the AramoError envelope.
  requestId: string;
  // Which subject survives the merge. Must be one of the advisory's pair; defaults
  // to subject_a (the canonical-lower id). The OTHER becomes the merged subject.
  surviving_subject_id?: string;
  // Reviewer justification. REQUIRED when overriding a contradiction (R3).
  justification?: string;
  // Explicit acknowledgment of a contradiction override (R3 — F34 accountability).
  override_acknowledged?: boolean;
}

export interface DismissInput {
  tenant_id: string;
  advisory_id: string;
  actor: string;
  requestId: string;
  justification?: string;
}

export interface ReverseMergeInput {
  tenant_id: string;
  advisory_id: string;
  actor: string;
  requestId: string;
  // Reversal justification is ALWAYS required (R4) — a merge is high-consequence.
  justification: string;
}

@Injectable()
export class SubjectResolutionService {
  constructor(
    private readonly repo: TalentTrustRepository,
    private readonly trust: TalentTrustService,
  ) {}

  // Approve a same-human advisory → execute the pointer-only merge + audit it.
  async approveMerge(input: ApproveMergeInput): Promise<SubjectMatchAdvisoryRow> {
    const advisory = await this.requirePending(
      input.tenant_id,
      input.advisory_id,
      input.requestId,
    );

    // Resolve the merge direction (surviving vs merged) within the advisory's pair.
    const { surviving, merged } = this.resolveDirection(
      advisory,
      input.requestId,
      input.surviving_subject_id,
    );

    // R3 — contradiction-gated override. A contradicted advisory may be merged, but
    // ONLY with an explicit acknowledgment + a non-empty justification (F34). Never silent.
    if (advisory.has_contradiction) {
      if (input.override_acknowledged !== true || !hasText(input.justification)) {
        throw new AramoError(
          'CONTRADICTION_OVERRIDE_REQUIRED',
          'contradiction_override_required: merging an advisory with has_contradiction=true ' +
            'requires override_acknowledged=true and a justification',
          400,
          { requestId: input.requestId, details: { advisory_id: advisory.id } },
        );
      }
    }

    // R5 idempotency — can't merge subjects that aren't both ACTIVE (e.g. one already
    // merged elsewhere). This also fails loud if a subject vanished.
    await this.requireActive(surviving, input.requestId);
    await this.requireActive(merged, input.requestId);

    const justification = hasText(input.justification) ? input.justification!.trim() : null;

    // The pointer-only, un-merge-safe merge. TR-6 B1 (DDR §5) — it now persists a
    // DIRECT_MERGE SubjectMergeOperation carrying the actor + reason (enriched by
    // the record-reconcile that follows in the controller).
    await this.trust.mergeSubjects(
      surviving,
      merged,
      justification ?? 'TR-2a-3 approve-merge',
      input.actor,
    );

    return this.repo.applyAdvisoryResolution({
      id: advisory.id,
      status: 'MERGED',
      resolution_action: 'MERGE',
      resolved_by: input.actor,
      resolved_at: new Date(),
      resolution_justification: justification,
      surviving_subject_id: surviving,
      merged_subject_id: merged,
    });
  }

  // Dismiss a same-human advisory → NOT the same human. No merge; audited.
  async dismiss(input: DismissInput): Promise<SubjectMatchAdvisoryRow> {
    const advisory = await this.requirePending(
      input.tenant_id,
      input.advisory_id,
      input.requestId,
    );
    const justification = hasText(input.justification) ? input.justification!.trim() : null;
    return this.repo.applyAdvisoryResolution({
      id: advisory.id,
      status: 'DISMISSED',
      resolution_action: 'DISMISS',
      resolved_by: input.actor,
      resolved_at: new Date(),
      resolution_justification: justification,
      surviving_subject_id: null,
      merged_subject_id: null,
    });
  }

  // Reverse a MERGED advisory → un-merge both subjects (restored to ACTIVE,
  // merged_into cleared) and record the reversal audit. Justification REQUIRED (R4).
  async reverseMerge(input: ReverseMergeInput): Promise<SubjectMatchAdvisoryRow> {
    if (!hasText(input.justification)) {
      throw new AramoError('REVERSAL_JUSTIFICATION_REQUIRED', 'reversal_justification_required', 400, {
        requestId: input.requestId,
        details: { advisory_id: input.advisory_id },
      });
    }
    const advisory = await this.repo.findMatchAdvisoryById(input.tenant_id, input.advisory_id);
    if (advisory === null) {
      throw new AramoError('NOT_FOUND', `advisory ${input.advisory_id} not found`, 404, {
        requestId: input.requestId,
      });
    }
    if (advisory.status !== 'MERGED') {
      throw new AramoError(
        'ADVISORY_NOT_MERGED',
        `advisory is ${advisory.status}, not MERGED — cannot reverse`,
        409,
        { requestId: input.requestId, details: { advisory_id: advisory.id, status: advisory.status } },
      );
    }
    if (advisory.merged_subject_id === null) {
      // Defensive: a MERGED advisory always records its merged subject.
      throw new AramoError(
        'ADVISORY_NO_MERGED_SUBJECT',
        `advisory ${input.advisory_id} has no merged_subject_id`,
        409,
        { requestId: input.requestId, details: { advisory_id: advisory.id } },
      );
    }

    // The reversal — pointer cleared, both subjects ACTIVE. TR-6 B1 (DDR §5): an
    // operation-backed merge (the common case here) records its reversal on the
    // existing operation via the controller's reconcile-reverse path; unmergeSubjects
    // only mints its own DIRECT_UNMERGE row when no prior operation exists.
    await this.trust.unmergeSubjects(
      advisory.merged_subject_id,
      input.justification.trim(),
      input.actor,
    );

    return this.repo.applyAdvisoryReversal({
      id: advisory.id,
      reversed_by: input.actor,
      reversed_at: new Date(),
      reversal_justification: input.justification.trim(),
    });
  }

  // ---- internals ------------------------------------------------------

  private async requirePending(
    tenantId: string,
    advisoryId: string,
    requestId: string,
  ): Promise<SubjectMatchAdvisoryRow> {
    const advisory = await this.repo.findMatchAdvisoryById(tenantId, advisoryId);
    if (advisory === null) {
      throw new AramoError('NOT_FOUND', `advisory ${advisoryId} not found`, 404, { requestId });
    }
    if (advisory.status !== 'PENDING_REVIEW') {
      // R5 — can't re-resolve an already-resolved advisory.
      throw new AramoError(
        'ADVISORY_NOT_PENDING',
        `advisory is already ${advisory.status} — cannot re-resolve`,
        409,
        { requestId, details: { advisory_id: advisory.id, status: advisory.status } },
      );
    }
    return advisory;
  }

  private resolveDirection(
    advisory: SubjectMatchAdvisoryRow,
    requestId: string,
    survivingSubjectId?: string,
  ): { surviving: string; merged: string } {
    if (survivingSubjectId === undefined) {
      // Default: the canonical-lower subject_a survives; subject_b merges into it.
      return { surviving: advisory.subject_a_id, merged: advisory.subject_b_id };
    }
    if (survivingSubjectId === advisory.subject_a_id) {
      return { surviving: advisory.subject_a_id, merged: advisory.subject_b_id };
    }
    if (survivingSubjectId === advisory.subject_b_id) {
      return { surviving: advisory.subject_b_id, merged: advisory.subject_a_id };
    }
    // A malformed body param — a genuine input validation (VALIDATION_ERROR is the
    // correct code, NOT one of the status-collapse false codes this slice fixes).
    throw new AramoError(
      'VALIDATION_ERROR',
      'surviving_subject_id must be one of the advisory pair (subject_a_id / subject_b_id)',
      400,
      { requestId, details: { advisory_id: advisory.id } },
    );
  }

  // TR-2a-B3a (DDR-3 §2.3/§5) — INTENTIONAL NON-FOLLOWER: the merge operands
  // must be ACTIVE in their OWN right (a subject already merged elsewhere is not
  // re-mergeable). Following the fixpoint here would mask exactly the double-
  // merge this guard exists to reject — do NOT switch to resolveActiveFixpoint.
  private async requireActive(subjectId: string, requestId: string): Promise<void> {
    const subject = await this.repo.findSubjectById(subjectId);
    if (subject === null) {
      throw new AramoError('NOT_FOUND', `ResolutionSubject ${subjectId} not found`, 404, {
        requestId,
      });
    }
    if (subject.status !== 'ACTIVE') {
      throw new AramoError(
        'MERGE_SUBJECT_NOT_ACTIVE',
        `ResolutionSubject ${subjectId} is ${subject.status}, not ACTIVE — cannot merge`,
        409,
        { requestId, details: { subject_id: subjectId, status: subject.status } },
      );
    }
  }
}

function hasText(v: string | undefined): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}
