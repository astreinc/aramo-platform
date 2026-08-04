import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { PlacementRepository, type PlacementProcessView } from '@aramo/placement';

import { READINESS_EVALUATOR, type ReadinessEvaluator } from './readiness-evaluator.js';

// Track 3 / E2 — the fail-closed READY_TO_START gate (§14 A2's PRIMARY control).
//
// The gate lives WITH the transition, not at an HTTP handler (PO carry). This
// service is the SOLE sanctioned path to placement PRE_START -> READY_TO_START:
// the controller, the materialize saga, the reconciler, and any future caller
// all mark readiness through here, so no path reaches that transition without
// first passing the assessBlocking check. A gate enforced only at a controller
// would be bypassable by every non-HTTP caller — placing it where the transition
// is performed is exactly what makes it the primary control rather than a UI guard.
//
// It composes @aramo/placement (the transition authority — its DB trigger owns
// edge legality) and @aramo/pre-start-requirement (the derivation). E2 the LIB
// never imports placement (LIB BOUNDARY); this apps/api orchestrator is where the
// two are allowed to meet.
@Injectable()
export class PlacementReadinessService {
  constructor(
    private readonly placements: PlacementRepository,
    @Inject(READINESS_EVALUATOR) private readonly evaluator: ReadinessEvaluator,
  ) {}

  // Attempt PRE_START -> READY_TO_START. Fail-closed: refused unless (a) a snapshot
  // exists (materialization completed) AND (b) no blocking requirement is
  // unresolved. Both refusals are the single PRE_START_NOT_READY (409) a caller
  // branches on, discriminated by details.reason (§10).
  async markReadyToStart(
    input: { tenant_id: string; placement_process_id: string },
    requestId: string,
  ): Promise<PlacementProcessView> {
    const assessment = await this.evaluator.assess(input.tenant_id, input.placement_process_id);

    // (a) Materialization has not completed — the async window the gate exists to
    // close. A placement here is NOT requirement-free; requirements are still being
    // prepared (or the intent is quarantined). Fail closed.
    if (!assessment.materialized) {
      throw new AramoError('PRE_START_NOT_READY', 'pre-start requirements are still being prepared', 409, {
        requestId,
        details: { reason: 'materialization_absent', placement_process_id: input.placement_process_id },
      });
    }

    // (b) One or more blocking requirements are pending / in-progress / failed.
    if (assessment.unresolved_blocking.length > 0) {
      throw new AramoError('PRE_START_NOT_READY', 'blocking pre-start requirements are unresolved', 409, {
        requestId,
        details: {
          reason: 'blocking_unresolved',
          blocking_unresolved_count: assessment.unresolved_blocking.length,
          placement_process_id: input.placement_process_id,
        },
      });
    }

    // Gate passed — perform the transition. Placement's trigger enforces the edge.
    return this.placements.transition(
      { tenant_id: input.tenant_id, placement_process_id: input.placement_process_id, to: 'READY_TO_START' },
      requestId,
    );
  }
}
