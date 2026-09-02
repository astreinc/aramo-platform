import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';

import { PreStartMaterializationService } from './pre-start-materialization.service.js';
import { PreStartCancellationService } from './pre-start-cancellation.service.js';
import { PRE_START_ORCHESTRATOR_SYSTEM_ACTOR_ID } from './pre-start-orchestrator.queue.constants.js';

// Lane 5 / L5-P1 (E2 ignition) — the pre-start lifecycle orchestrator (apps/api
// composition root). This is the wire that was cut: E2's materialize saga,
// reconciler, and terminal cancellation shipped with NO production caller. This
// orchestrator ignites them off the durable placement outbox facts.
//
// Two governed consequences, each driven by AUTHORITATIVE STORED STATE (no new
// truth introduced — the Aramo one-owner law):
//   placement.process.created                 → materialize the applicable snapshot
//   placement.process.state_changed(NO_SHOW / FELL_THROUGH) → cancel unresolved reqs
//
// IDEMPOTENCY WITHOUT A NEW INBOX (§L5-P1 Design B). E2 already owns the two
// consumption markers, so a dedicated inbox table would be duplicate truth:
//   - intake:   PreStartMaterializationIntent is UNIQUE(tenant, placement) — the
//               idempotency floor. We drain created events with NO intent yet;
//               ensureIntent creates it, so the same event is excluded next tick and
//               the reconciler (listPending) owns retries thereafter.
//   - terminal: cancelForTerminalPlacement acts ONLY on unresolved instances and is
//               idempotent. We drain terminal events WHILE unresolved instances still
//               exist; once every instance is CANCELED the EXISTS predicate excludes
//               the event. Self-limiting, retry-safe, no marker column.
//
// The raw reads are a bounded cross-schema LEFT JOIN / EXISTS on ONE pooled
// connection (placement.OutboxEvent lives in the same physical DB as the pre_start
// schema), mirroring PlacementLifecycleOrchestratorService. E2's transition
// authority is NEVER bypassed — every write goes through the governed E2 services.

const OUTBOX_CREATED_EVENT_TYPE = 'placement.process.created';
const OUTBOX_STATE_CHANGED_EVENT_TYPE = 'placement.process.state_changed';

interface RawDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

interface CreatedEventRow {
  tenant_id: string;
  placement_process_id: string;
  // L5-P5 — the layered precedence refs. requisition_id is on the created event;
  // client_id is the requisition's company_id (LEFT JOIN — null when unresolved).
  requisition_id: string | null;
  client_id: string | null;
}

interface TerminalEventRow {
  tenant_id: string;
  placement_process_id: string;
  to_state: 'NO_SHOW' | 'FELL_THROUGH';
}

@Injectable()
export class PreStartOrchestratorService {
  constructor(
    @Inject('PreStartOrchestratorDb') private readonly db: RawDb,
    private readonly materialization: PreStartMaterializationService,
    private readonly cancellation: PreStartCancellationService,
    @Inject('PreStartOrchestratorLogger') private readonly logger: AramoLogger,
  ) {}

  // The tick — run all three E2 drains in order: reconcile first (drain any intent a
  // prior tick left pending), then intake fresh created events, then terminal cancels.
  // Returns per-drain counts for operational visibility.
  async tick(limit: number): Promise<{ reconciled: number; intake: number; cancelled: number }> {
    const { processed: reconciled } = await this.materialization.reconcile(limit);
    const intake = await this.drainIntake(limit);
    const cancelled = await this.drainTerminalCancellations(limit);
    this.logger.log({ event: 'pre_start_orchestrator_tick', reconciled, intake, cancelled });
    return { reconciled, intake, cancelled };
  }

  // created → materialize. Read placement.process.created events whose placement has
  // NO materialization intent yet (LEFT JOIN on the same pooled connection). For each,
  // call the governed materialize saga; ensureIntent is the race-safe idempotency floor
  // so a concurrent tick or re-delivery collapses to the one intent.
  async drainIntake(limit: number): Promise<number> {
    const rows = await this.db.$queryRawUnsafe<CreatedEventRow[]>(
      `SELECT o."tenant_id",
              (o."event_payload"->>'placement_process_id')::uuid AS placement_process_id,
              (o."event_payload"->>'requisition_id')::uuid AS requisition_id,
              r."company_id" AS client_id
         FROM "placement"."OutboxEvent" o
         LEFT JOIN "pre_start_requirement"."PreStartMaterializationIntent" mi
           ON mi."tenant_id" = o."tenant_id"
          AND mi."placement_process_id" = (o."event_payload"->>'placement_process_id')::uuid
         LEFT JOIN "requisition"."Requisition" r
           ON r."tenant_id" = o."tenant_id"
          AND r."id" = (o."event_payload"->>'requisition_id')::uuid
        WHERE o."event_type" = $1
          AND mi."placement_process_id" IS NULL
        ORDER BY o."created_at" ASC
        LIMIT $2`,
      OUTBOX_CREATED_EVENT_TYPE,
      limit,
    );

    let materialized = 0;
    for (const row of rows) {
      // TENANT baseline (scope_ref_id == tenant_id) + the layered CLIENT/REQUISITION
      // context (L5-P5). materializeForPlacement is idempotent via ensureIntent, which
      // stores the context so the reconciler re-resolves the same chain.
      await this.materialization.materializeForPlacement({
        tenant_id: row.tenant_id,
        placement_process_id: row.placement_process_id,
        scope: 'TENANT',
        scope_ref_id: row.tenant_id,
        client_id: row.client_id,
        requisition_id: row.requisition_id,
      });
      materialized += 1;
    }
    return materialized;
  }

  // terminal → cancel. Read placement terminal events (NO_SHOW / FELL_THROUGH) for
  // placements that STILL have unresolved requirement instances, and cancel them
  // through the governed E2 cancellation service. Self-limiting: once every instance is
  // resolved the EXISTS predicate excludes the event.
  async drainTerminalCancellations(limit: number): Promise<number> {
    const rows = await this.db.$queryRawUnsafe<TerminalEventRow[]>(
      `SELECT o."tenant_id",
              (o."event_payload"->>'placement_process_id')::uuid AS placement_process_id,
              (o."event_payload"->>'to_state') AS to_state
         FROM "placement"."OutboxEvent" o
        WHERE o."event_type" = $1
          AND (o."event_payload"->>'to_state') IN ('NO_SHOW', 'FELL_THROUGH')
          AND EXISTS (
            SELECT 1
              FROM "pre_start_requirement"."PreStartRequirementInstance" ri
             WHERE ri."tenant_id" = o."tenant_id"
               AND ri."placement_process_id" = (o."event_payload"->>'placement_process_id')::uuid
               AND ri."status" NOT IN ('SATISFIED', 'WAIVED', 'CANCELED')
          )
        ORDER BY o."created_at" ASC
        LIMIT $2`,
      OUTBOX_STATE_CHANGED_EVENT_TYPE,
      limit,
    );

    let cancelledPlacements = 0;
    for (const row of rows) {
      const reason =
        row.to_state === 'NO_SHOW' ? 'placement_no_show' : 'placement_fell_through';
      await this.cancellation.cancelForTerminalPlacement(
        row.tenant_id,
        row.placement_process_id,
        reason,
        PRE_START_ORCHESTRATOR_SYSTEM_ACTOR_ID,
        `pso-cancel-${row.placement_process_id}`,
      );
      cancelledPlacements += 1;
    }
    return cancelledPlacements;
  }
}
