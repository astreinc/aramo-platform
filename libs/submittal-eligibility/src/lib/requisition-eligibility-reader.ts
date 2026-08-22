import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { deriveWindowStatus } from './submittal-eligibility.port.js';
import type {
  SubmittalPolicyInputs,
  WindowStatusDerivation,
} from './submittal-eligibility.port.js';
import type { SubmittalWindowStatusValue } from './submittal-eligibility-vocab.js';

// Lane L8-B2 (read-exposure amendment) — requisition-grain Client Status reader.
//
// The AUTHORITATIVE answer to "may another client submittal be sent right now?" per
// requisition — derived from the SubmittalEligibility truth
// (`RequisitionSubmittalPolicy` + `SubmittalConsumption` count), NEVER from the pipeline
// mirror or `Submittal.state` counts (R-AUTH). Requisition-grain only: it uses the pure
// `deriveWindowStatus` (policy window + consumed count), which does NOT consult the
// per-Talent `restriction_active` input — so the per-Talent restriction is structurally
// excluded from the requisition-wide status (R-EXCLUDE-RESTRICTION). SET-oriented (one
// grouped read per population, never N per-requisition reads — the T4-B2 reporting rule).

/** The requisition-grain tri-state (R-SEMANTICS). */
export type ClientSubmittalStatus = 'open' | 'paused' | 'closed';

/** The nullable "why" for a non-OPEN status (R-SEMANTICS secondary detail). */
export type ClientSubmittalReason =
  | 'deadline_passed'
  | 'limit_reached'
  | 'manual_hold'
  | 'paused';

export interface RequisitionClientSubmittalView {
  readonly status: ClientSubmittalStatus;
  readonly reason: ClientSubmittalReason | null;
}

@Injectable()
export class RequisitionSubmittalEligibilityReader {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Requisition-grain Client Status for a SET of requisitions. Every input id gets an
   * entry; a requisition with no policy row derives to OPEN (R-DEFAULT-OPEN). `now` is
   * passed in, never read from a clock here.
   */
  async deriveByRequisitionIds(
    tenant_id: string,
    requisition_ids: readonly string[],
    now: Date,
  ): Promise<Map<string, RequisitionClientSubmittalView>> {
    const out = new Map<string, RequisitionClientSubmittalView>();
    if (requisition_ids.length === 0) return out;
    const ids = [...requisition_ids];

    // SET-oriented: ONE policy read + ONE grouped consumption count for the whole
    // population (never N per-requisition reads — the T4-B2 reporting rule).
    const [policies, consumption] = await Promise.all([
      this.prisma.requisitionSubmittalPolicy.findMany({
        where: { tenant_id, requisition_id: { in: ids } },
      }),
      this.prisma.submittalConsumption.groupBy({
        by: ['requisition_id'],
        where: { tenant_id, requisition_id: { in: ids } },
        _count: { _all: true },
      }),
    ]);
    const policyByReq = new Map(policies.map((p) => [p.requisition_id, p]));
    const consumedByReq = new Map(
      consumption.map((g) => [g.requisition_id, g._count._all]),
    );

    for (const requisition_id of ids) {
      const row = policyByReq.get(requisition_id);
      const inputs: SubmittalPolicyInputs = row
        ? inputsFrom(row)
        : { submittal_deadline: null, submittal_limit: null, manual_override: null, submittal_authority: 'ARAMO' };
      const derived = deriveWindowStatus(inputs, {
        now,
        consumed_count: consumedByReq.get(requisition_id) ?? 0,
        restriction_active: false, // R-EXCLUDE-RESTRICTION — per-Talent, never requisition-wide.
      });
      const status: ClientSubmittalStatus =
        derived.status === 'OPEN' ? 'open' : derived.status === 'PAUSED' ? 'paused' : 'closed';
      out.set(requisition_id, { status, reason: reasonFromClosedBy(derived.closed_by) });
    }
    return out;
  }
}

// Maps the pure derivation's `closed_by` to the wire reason (R-SEMANTICS).
export function reasonFromClosedBy(
  closed_by: WindowStatusDerivation['closed_by'],
): ClientSubmittalReason | null {
  switch (closed_by) {
    case 'DEADLINE':
      return 'deadline_passed';
    case 'QUOTA':
      return 'limit_reached';
    case 'MANUAL':
      return 'manual_hold';
    case 'PAUSED':
      return 'paused';
    default:
      return null;
  }
}

// Local helper kept exported for the proof's non-vacuous BEFORE assertion.
export function inputsFrom(row: {
  submittal_deadline: Date | null;
  submittal_limit: number | null;
  manual_override: string | null;
  submittal_authority: string;
}): SubmittalPolicyInputs {
  return {
    submittal_deadline: row.submittal_deadline,
    submittal_limit: row.submittal_limit,
    manual_override: row.manual_override as SubmittalWindowStatusValue | null,
    submittal_authority: row.submittal_authority as never,
  };
}
