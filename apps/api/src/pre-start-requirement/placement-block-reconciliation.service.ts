import { Injectable } from '@nestjs/common';
import { PlacementRepository, type PlacementProcessView } from '@aramo/placement';
import { RequirementInstanceRepository } from '@aramo/pre-start-requirement';

// Lane 5 / L5-P4 (ruling P3) — BLOCKED as a governed PROJECTION of the authoritative
// requirement facts. BLOCKED's cause is a blocking requirement in FAILED (intervention
// needed); it is NOT a separate stored blocker truth. This service keeps the placement's
// PRE_START <-> BLOCKED state a faithful projection of that fact, driven by a governed
// consequence at the requirement-status-change seam.
//
// Idempotent: transitions ONLY when the placement state disagrees with the projection.
// It touches ONLY the PRE_START <-> BLOCKED projection edge — never READY_TO_START,
// STARTED, or a terminal (those are not projections of the blocker signal). Ruling P3's
// edge rule (BLOCKED -> PRE_START, never BLOCKED -> READY_TO_START) is the placement
// lifecycle's own authority; this service never attempts the illegal edge.
//
// It lives in apps/api (the composition root where placement and pre-start are allowed
// to meet) — the E2 lib never imports placement, and no libs/placement ->
// libs/pre-start-requirement edge is created (Lane-5 exit contract).
@Injectable()
export class PlacementBlockReconciliationService {
  constructor(
    private readonly placements: PlacementRepository,
    private readonly requirements: RequirementInstanceRepository,
  ) {}

  // Reconcile the placement's PRE_START <-> BLOCKED state against the blocker projection.
  // Returns the (possibly transitioned) placement view, or null when nothing changed
  // (state already matches the projection, or the placement is past the pre-start phase).
  async reconcile(
    tenant_id: string,
    placement_process_id: string,
    requestId: string,
  ): Promise<PlacementProcessView | null> {
    const placement = await this.placements.findById(tenant_id, placement_process_id);
    if (placement === null) return null;

    // Only the PRE_START <-> BLOCKED projection edge is reconciled here.
    if (placement.state !== 'PRE_START' && placement.state !== 'BLOCKED') return null;

    const projection = await this.requirements.deriveBlockers(tenant_id, placement_process_id);

    if (placement.state === 'PRE_START' && projection.blocked) {
      // A blocking requirement FAILED — surface the block as a placement-level projection.
      return this.placements.transition(
        { tenant_id, placement_process_id, to: 'BLOCKED' },
        requestId,
      );
    }
    if (placement.state === 'BLOCKED' && !projection.blocked) {
      // The failure was resolved (satisfied / waived / reopened) — return to normal
      // onboarding. BLOCKED -> PRE_START only; never BLOCKED -> READY_TO_START.
      return this.placements.transition(
        { tenant_id, placement_process_id, to: 'PRE_START' },
        requestId,
      );
    }
    return null;
  }
}
