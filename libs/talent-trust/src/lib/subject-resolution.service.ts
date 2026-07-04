import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

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

export interface ApproveMergeInput {
  tenant_id: string;
  advisory_id: string;
  // The privileged actor (JWT sub) — recorded as resolved_by (R4).
  actor: string;
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
  justification?: string;
}

export interface ReverseMergeInput {
  tenant_id: string;
  advisory_id: string;
  actor: string;
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
    const advisory = await this.requirePending(input.tenant_id, input.advisory_id);

    // Resolve the merge direction (surviving vs merged) within the advisory's pair.
    const { surviving, merged } = this.resolveDirection(advisory, input.surviving_subject_id);

    // R3 — contradiction-gated override. A contradicted advisory may be merged, but
    // ONLY with an explicit acknowledgment + a non-empty justification (F34). Never silent.
    if (advisory.has_contradiction) {
      if (input.override_acknowledged !== true || !hasText(input.justification)) {
        throw new BadRequestException(
          'contradiction_override_required: merging an advisory with has_contradiction=true ' +
            'requires override_acknowledged=true and a justification',
        );
      }
    }

    // R5 idempotency — can't merge subjects that aren't both ACTIVE (e.g. one already
    // merged elsewhere). This also fails loud if a subject vanished.
    await this.requireActive(surviving);
    await this.requireActive(merged);

    const justification = hasText(input.justification) ? input.justification!.trim() : null;

    // The EXISTING pointer-only, un-merge-safe merge (unchanged by this slice).
    await this.trust.mergeSubjects(
      surviving,
      merged,
      justification ?? 'TR-2a-3 approve-merge',
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
    const advisory = await this.requirePending(input.tenant_id, input.advisory_id);
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
      throw new BadRequestException('reversal_justification_required');
    }
    const advisory = await this.repo.findMatchAdvisoryById(input.tenant_id, input.advisory_id);
    if (advisory === null) {
      throw new NotFoundException(`advisory ${input.advisory_id} not found`);
    }
    if (advisory.status !== 'MERGED') {
      throw new ConflictException(
        `advisory ${input.advisory_id} is ${advisory.status}, not MERGED — cannot reverse`,
      );
    }
    if (advisory.merged_subject_id === null) {
      // Defensive: a MERGED advisory always records its merged subject.
      throw new ConflictException(`advisory ${input.advisory_id} has no merged_subject_id`);
    }

    // The EXISTING reversal — pointer cleared, both subjects ACTIVE (unchanged by this slice).
    await this.trust.unmergeSubjects(advisory.merged_subject_id, input.justification.trim());

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
  ): Promise<SubjectMatchAdvisoryRow> {
    const advisory = await this.repo.findMatchAdvisoryById(tenantId, advisoryId);
    if (advisory === null) {
      throw new NotFoundException(`advisory ${advisoryId} not found`);
    }
    if (advisory.status !== 'PENDING_REVIEW') {
      // R5 — can't re-resolve an already-resolved advisory.
      throw new ConflictException(
        `advisory ${advisoryId} is already ${advisory.status} — cannot re-resolve`,
      );
    }
    return advisory;
  }

  private resolveDirection(
    advisory: SubjectMatchAdvisoryRow,
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
    throw new BadRequestException(
      'surviving_subject_id must be one of the advisory pair (subject_a_id / subject_b_id)',
    );
  }

  private async requireActive(subjectId: string): Promise<void> {
    const subject = await this.repo.findSubjectById(subjectId);
    if (subject === null) {
      throw new NotFoundException(`ResolutionSubject ${subjectId} not found`);
    }
    if (subject.status !== 'ACTIVE') {
      throw new ConflictException(
        `ResolutionSubject ${subjectId} is ${subject.status}, not ACTIVE — cannot merge`,
      );
    }
  }
}

function hasText(v: string | undefined): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}
