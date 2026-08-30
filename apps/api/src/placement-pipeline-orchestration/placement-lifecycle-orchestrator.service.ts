import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';
import { PipelineRepository, isLiveStatus } from '@aramo/pipeline';
import {
  PlacementPipelineInboxRepository,
  PLACEMENT_STATE_CHANGED_EVENT_TYPE,
  type InboxOutcomeCode,
  type PlacementStateChangedPayload,
} from '@aramo/placement-pipeline-bridge';

// Lane 2 / L2-G (Part 3) — the Placement→Pipeline lifecycle orchestrator (apps/api
// composition root; v1.2 R-BRIDGE/R-CMD/R-PROC/R-LINEAGE/R-NOTX). Consumes the durable
// `placement.process.state_changed` fact and drives the Pipeline system commands by
// AUTHORITATIVE STORED LINEAGE:
//   placement event.submittal_id → Submittal.pipeline_id → the EXACT Pipeline episode.
// (tenant,talent,requisition) matching is NEVER used as an ownership guess.
//   STARTED                    → Pipeline COMPLETE (system-only, read-then-CAS)
//   FELL_THROUGH / NO_SHOW      → Pipeline dispositionDownstream → not_in_consideration
// Idempotent inbox consumer: reserve(event.id) is the idempotency authority (re-delivery =
// success no-op); the row is marked processed ONLY after the command succeeds OR reaches a
// recognized-satisfied state. A TRANSIENT failure (CAS conflict) leaves the row pending
// (retry-safe). NO distributed transaction spans the bridge and pipeline schemas. Placement
// is NOT imported; the pipeline side uses the injected PipelineRepository (apps/api-legal).

// A dedicated system principal + capability for the lifecycle bridge — the first production
// caller of the system-only pipeline:complete surface. Fixed UUID (audit-stable), not a
// tenant user; the pipeline command records it as changed_by_id / ended_by_id.
export const PIPELINE_LIFECYCLE_SYSTEM_ACTOR_ID =
  '01900000-0000-7000-8000-000000000005';
export const SYSTEM_LIFECYCLE_SCOPES: readonly string[] = ['pipeline:complete'];

interface RawDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

interface EventRow {
  id: string;
  tenant_id: string;
  event_payload: PlacementStateChangedPayload;
}

@Injectable()
export class PlacementLifecycleOrchestratorService {
  constructor(
    @Inject('PlacementLifecycleDb') private readonly db: RawDb,
    private readonly inbox: PlacementPipelineInboxRepository,
    private readonly pipeline: PipelineRepository,
    @Inject('PlacementLifecycleOrchestratorLogger')
    private readonly logger: AramoLogger,
  ) {}

  // Drain a batch of not-yet-consumed placement.process.state_changed events and process
  // each idempotently. Returns per-outcome counts for the tick log.
  async drainBatch(args: { limit: number }): Promise<Record<string, number>> {
    // Read events not yet CONSUMED — either no bridge-inbox row at all, OR a row still
    // `pending` (a prior transient failure left it un-processed → retry-safe re-pick).
    // A `processed` row is terminal and excluded. Bounded cross-schema LEFT JOIN in the
    // same DB. published_at is the PUBLISHER's marker and is intentionally NOT consulted.
    const rows = await this.db.$queryRawUnsafe<EventRow[]>(
      `SELECT o."id", o."tenant_id", o."event_payload"
         FROM "placement"."OutboxEvent" o
         LEFT JOIN "placement_pipeline_bridge"."PlacementPipelineInbox" i
           ON i."placement_event_id" = o."id"
        WHERE o."event_type" = $1
          AND (i."placement_event_id" IS NULL OR i."status" = 'pending')
        ORDER BY o."created_at" ASC
        LIMIT $2`,
      PLACEMENT_STATE_CHANGED_EVENT_TYPE,
      args.limit,
    );

    const counts: Record<string, number> = {};
    for (const row of rows) {
      const outcome = await this.processOne(row);
      if (outcome !== null) counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    this.logger.log({
      event: 'placement_lifecycle_orchestrator_tick',
      scanned: rows.length,
      ...counts,
    });
    return counts;
  }

  // Process a single event with reserve→act→markProcessed. Returns the classified outcome,
  // or null when a transient failure left the row pending (retry-safe).
  private async processOne(row: EventRow): Promise<InboxOutcomeCode | null> {
    const reservation = await this.inbox.reserve({
      placement_event_id: row.id,
      tenant_id: row.tenant_id,
      event_type: PLACEMENT_STATE_CHANGED_EVENT_TYPE,
    });
    // A genuine duplicate delivery of an already-PROCESSED event → success no-op.
    // 'created' (fresh) and 'pending' (prior transient / retry) both proceed to act.
    if (reservation.disposition === 'processed') return null;

    const payload = row.event_payload;
    const requestId = `plo-${row.id}`;
    const toState = payload.to_state;

    // Only STARTED / FELL_THROUGH / NO_SHOW are actionable at the bridge.
    if (toState !== 'STARTED' && toState !== 'FELL_THROUGH' && toState !== 'NO_SHOW') {
      return this.finish(row.id, 'event_not_actionable');
    }

    // Resolve the EXACT episode from stored lineage: submittal_id → Submittal.pipeline_id.
    const subs = await this.db.$queryRawUnsafe<Array<{ pipeline_id: string | null }>>(
      `SELECT "pipeline_id" FROM "submittal"."TalentSubmittalRecord"
        WHERE "id" = $1::uuid AND "tenant_id" = $2::uuid LIMIT 1`,
      payload.submittal_id,
      payload.tenant_id,
    );
    const pipelineId = subs[0]?.pipeline_id ?? null;
    if (pipelineId === null) {
      // No authoritative pipeline lineage — nothing to act on (classified skip, processed).
      this.logger.log({ event: 'placement_lifecycle_no_lineage', placement_event_id: row.id, submittal_id: payload.submittal_id });
      return this.finish(row.id, 'no_pipeline_lineage');
    }

    const episode = await this.pipeline.findById({ tenant_id: payload.tenant_id, id: pipelineId });
    if (episode === null) {
      return this.finish(row.id, 'no_pipeline_lineage');
    }

    if (toState === 'STARTED') {
      return this.handleStarted(row.id, payload, episode);
    }
    return this.handleFallthrough(row.id, payload, episode);
  }

  // STARTED → COMPLETE the exact LIVE episode (read-then-CAS). Already-completed / not-live
  // → recognized-satisfied; CAS conflict → transient (leave pending).
  private async handleStarted(
    eventId: string,
    payload: PlacementStateChangedPayload,
    episode: { id: string; status: string; version: number },
  ): Promise<InboxOutcomeCode | null> {
    if (episode.status === 'completed') {
      return this.finish(eventId, 'already_satisfied'); // already closed by a prior delivery
    }
    if (!isLiveStatus(episode.status as never)) {
      // A non-live episode (already terminal) — never reopen a historical episode.
      return this.finish(eventId, 'pipeline_not_live');
    }
    try {
      await this.pipeline.complete({
        tenant_id: payload.tenant_id,
        id: episode.id,
        expected_version: episode.version,
        changed_by_id: PIPELINE_LIFECYCLE_SYSTEM_ACTOR_ID,
        requestId: `plo-complete-${eventId}`,
        visible_requisition_ids: null,
        scopes: SYSTEM_LIFECYCLE_SCOPES,
        source_provenance: payload.placement_process_id,
        reason: 'placement_started',
      });
      return this.finish(eventId, 'completed');
    } catch (err) {
      return this.classifyCommandError(eventId, err, 'complete');
    }
  }

  // FELL_THROUGH / NO_SHOW (pre-STARTED) → dispositionDownstream → not_in_consideration.
  // Already terminal / already-dispositioned → recognized-satisfied; CAS conflict → pending.
  private async handleFallthrough(
    eventId: string,
    payload: PlacementStateChangedPayload,
    episode: { status: string; version: number; id?: string },
  ): Promise<InboxOutcomeCode | null> {
    if (!isLiveStatus(episode.status as never)) {
      return this.finish(eventId, 'already_satisfied'); // already terminal — don't reopen
    }
    try {
      await this.pipeline.dispositionDownstream({
        tenant_id: payload.tenant_id,
        id: (episode as { id: string }).id,
        expected_version: episode.version,
        changed_by_id: PIPELINE_LIFECYCLE_SYSTEM_ACTOR_ID,
        requestId: `plo-dispo-${eventId}`,
        visible_requisition_ids: null,
        scopes: SYSTEM_LIFECYCLE_SCOPES,
        source_provenance: payload.placement_process_id,
        // No `no_show` reason exists; both fall-through and no-show use placement_fell_through.
        reason: 'placement_fell_through',
      });
      return this.finish(eventId, 'dispositioned');
    } catch (err) {
      return this.classifyCommandError(eventId, err, 'disposition');
    }
  }

  // Map a Pipeline command error to an outcome. Recognized-satisfied (already disposed) →
  // processed; a stale-version CAS conflict is TRANSIENT → leave the row pending (retry).
  private async classifyCommandError(
    eventId: string,
    err: unknown,
    op: 'complete' | 'disposition',
  ): Promise<InboxOutcomeCode | null> {
    const code =
      err instanceof AramoError ? err.code : undefined;
    if (code === 'PIPELINE_ALREADY_DISPOSITIONED') {
      return this.finish(eventId, 'already_satisfied');
    }
    if (code === 'PIPELINE_TRANSITION_CONFLICT') {
      // Concurrent advance — leave PENDING so a later tick retries with a fresh version.
      this.logger.warn({ event: 'placement_lifecycle_transient_conflict', placement_event_id: eventId, op });
      return null;
    }
    if (code === 'INVALID_PIPELINE_TRANSITION') {
      // The live episode is not in a state this command can act on (e.g. not qualified for
      // COMPLETE). Not retryable — classified skip.
      this.logger.warn({ event: 'placement_lifecycle_not_actionable', placement_event_id: eventId, op });
      return this.finish(eventId, 'pipeline_not_live');
    }
    // Unknown/transient infra error — leave pending for retry (do NOT mark processed).
    this.logger.error({ event: 'placement_lifecycle_transient_error', placement_event_id: eventId, op, message: err instanceof Error ? err.message : String(err) });
    return null;
  }

  private async finish(eventId: string, outcome: InboxOutcomeCode): Promise<InboxOutcomeCode> {
    await this.inbox.markProcessed({ placement_event_id: eventId, outcome_code: outcome });
    return outcome;
  }
}
