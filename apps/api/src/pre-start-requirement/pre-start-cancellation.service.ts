import { Injectable } from '@nestjs/common';
import { RequirementInstanceRepository, type InstanceView } from '@aramo/pre-start-requirement';

// Track 3 / E2 — GOVERNED cancellation (§14 A2-C). Cancellation is NOT a user
// action: there is no controller route, no DTO, no scope a caller presents to
// cancel. `CANCELED` is reachable ONLY through this internal service, invoked by
// a governed application/system workflow AFTER a separately authoritative business
// event (the placement itself reaching a terminal state). A cancellation records
// that the requirement no longer APPLIES — it is not a waiver (a decision to
// proceed WITHOUT the requirement), and it never routes around waive_blocking's
// zero grants. Every cancellation writes immutable audit provenance (the repo
// appends a CANCELED audit row in the same transaction).
//
// This service is exported for the future placement-lifecycle workflow to call;
// it is deliberately NOT registered on any controller.
@Injectable()
export class PreStartCancellationService {
  constructor(private readonly requirements: RequirementInstanceRepository) {}

  // Cancel every still-unresolved requirement for a placement whose governing
  // event no longer holds (e.g. the placement fell through). actor_type is
  // 'system' — this is a governed workflow action, not a human self-serve one.
  async cancelForTerminalPlacement(
    tenant_id: string,
    placement_process_id: string,
    reason: string,
    actor_id: string,
    requestId: string,
  ): Promise<readonly InstanceView[]> {
    const instances = await this.requirements.findByPlacement(tenant_id, placement_process_id);
    const cancelled: InstanceView[] = [];
    for (const inst of instances) {
      // Only unresolved instances are cancellable (SATISFIED/WAIVED/CANCELED are
      // terminal; the status guard also enforces this).
      if (inst.status === 'SATISFIED' || inst.status === 'WAIVED' || inst.status === 'CANCELED') {
        continue;
      }
      const updated = await this.requirements.applyStatusMove(
        {
          tenant_id,
          requirement_instance_id: inst.id,
          to: 'CANCELED',
          actor_id,
          actor_type: 'system',
          reason,
          source: 'placement_terminal_workflow',
        },
        requestId,
      );
      cancelled.push(updated);
    }
    return cancelled;
  }
}
