import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';
import {
  RequisitionRepository,
  TRANSITION_ACTIONS,
  isExternalLifecycleAction,
  type ExternalLifecycleTransitionCommand,
  type TransitionAction,
} from '@aramo/requisition';
import {
  CONNECTOR_SERVICE_ACCOUNT_ID,
  RECONCILIATION_DISPOSITION,
  classifyReconciliation,
  isReconciliationFailureReason,
  ExternalRequisitionIdentityRepository,
  RequisitionExternalReconciliationRepository,
  RequisitionExternalTransitionProvenanceRepository,
  RequisitionLifecycleMappingRepository,
  type ClaimedReconciliationRow,
  type ReconciliationDisposition,
} from '@aramo/integration';

import {
  RECONCILIATION_DRAIN_BACKOFF_MS,
  RECONCILIATION_DRAIN_BATCH_SIZE,
  RECONCILIATION_DRAIN_LEASE_MS,
  RECONCILIATION_DRAIN_MAX_ATTEMPTS,
} from './reconciliation-drain.queue.constants.js';

// CB-D2-R (ADR-0030) — the reconciliation-DRAINING worker (apps/api composition
// root; mirrors talent-reconcile). It claims a bounded batch of due pending
// RequisitionExternalReconciliation rows (the rows A1 + FG only WRITE today) and,
// per row, EITHER re-runs the SAME governed command path (RE_EVALUABLE), marks
// resolved with NO mutation (SUPERSEDED), or parks after bounded attempts
// (INTERVENTION / poison). DUAL_CONTROL_PENDING is EXCLUDED by the claim query.
//
// GOVERNING INVARIANT (inherited): this worker NEVER writes Requisition.status
// directly. Any auto-resolution re-resolves identity + mapping, then calls the
// GOVERNED command seam (executeExternalLifecycleCommand: gate -> CAS -> atomic
// audit) as the connector service account (never a human, no HTTP route). The
// only status-writing path is that seam — the HARD-PROHIBITION scan stays green.
//
// R-REATTEMPT (narrow composition): the worker does NOT re-call
// ExternalLifecycleReconciler.ingest (which would rewrite a fresh pending row on
// refusal and never resolve the original). It owns a narrow re-attempt:
// re-resolve requisition_id (a null/unresolved identity is non-replayable -> park,
// never guessed), re-resolve mapping, reload (status, version), and call the seam
// with expected_version = the reloaded version (Aramo's OWN optimistic guard, NOT
// provider ordering -> CAS SEPARATION preserved). CAS_CONFLICT is NOT a spin loop:
// one seam call per drain; on CAS_CONFLICT reschedule (backoff) under the cap then
// park. Never throws out of the batch (per-row try/catch -> transient -> bump).

export type DrainRowOutcome =
  | 'resolved'
  | 'superseded'
  | 'parked'
  | 'rescheduled'
  | 'excluded';

export interface ReconciliationDrainResult {
  attempted: number;
  resolved: number;
  superseded: number;
  parked: number;
  rescheduled: number;
  excluded: number;
}

interface DrainContext {
  maxAttempts: number;
  backoffMs: number;
}

@Injectable()
export class RequisitionReconciliationDrainService {
  constructor(
    private readonly reconciliations: RequisitionExternalReconciliationRepository,
    private readonly identities: ExternalRequisitionIdentityRepository,
    private readonly mappings: RequisitionLifecycleMappingRepository,
    private readonly provenance: RequisitionExternalTransitionProvenanceRepository,
    private readonly requisitions: RequisitionRepository,
    @Inject('ReconciliationDrainServiceLogger')
    private readonly logger: AramoLogger,
  ) {}

  // The connector service account — the ONLY principal this worker acts as when
  // invoking the governed command seam (never a human, never requisition:edit).
  private readonly connectorPrincipalId = CONNECTOR_SERVICE_ACCOUNT_ID;

  // Provider-state normalization — trim + lowercase, IDENTICAL to the reconciler,
  // so the mapping re-lookup keys on the same normalized token.
  private normalize(raw: string): string {
    return raw.trim().toLowerCase();
  }

  /**
   * Claim + drain a bounded batch. Exposed for the integration spec (the
   * talent-reconcile test-seam precedent — prove the drain end-to-end without a
   * live Redis worker). Never throws — a per-row failure bumps/parks and the
   * batch continues.
   */
  async drainBatch(args?: {
    batchSize?: number;
    maxAttempts?: number;
    leaseMs?: number;
    backoffMs?: number;
    lockedBy?: string;
  }): Promise<ReconciliationDrainResult> {
    const batchSize = args?.batchSize ?? RECONCILIATION_DRAIN_BATCH_SIZE;
    const maxAttempts = args?.maxAttempts ?? RECONCILIATION_DRAIN_MAX_ATTEMPTS;
    const leaseMs = args?.leaseMs ?? RECONCILIATION_DRAIN_LEASE_MS;
    const backoffMs = args?.backoffMs ?? RECONCILIATION_DRAIN_BACKOFF_MS;
    const lockedBy = args?.lockedBy ?? 'reconciliation-drain';

    const claimed = await this.reconciliations.claimDuePending({
      limit: batchSize,
      lockedBy,
      leaseMs,
    });

    const result: ReconciliationDrainResult = {
      attempted: claimed.length,
      resolved: 0,
      superseded: 0,
      parked: 0,
      rescheduled: 0,
      excluded: 0,
    };
    if (claimed.length === 0) {
      this.logger.debug({ event: 'reconciliation_drain_tick_empty', locked_by: lockedBy });
      return result;
    }

    const ctx: DrainContext = { maxAttempts, backoffMs };
    for (const row of claimed) {
      const outcome = await this.processRow(row, ctx);
      result[outcome] += 1;
    }
    return result;
  }

  // Process ONE claimed row. Never throws — a transient failure is bumped/parked.
  private async processRow(
    row: ClaimedReconciliationRow,
    ctx: DrainContext,
  ): Promise<DrainRowOutcome> {
    const base = {
      tenant_id: row.tenant_id,
      connection_id: row.connection_id,
      provider_key: row.provider_key,
      external_req_id: row.external_req_id,
      reconciliation_id: row.id,
      failure_reason: row.failure_reason,
      attempts: row.attempts,
    };
    try {
      // Defensive — an unrecognized token is never silently mis-drained.
      if (!isReconciliationFailureReason(row.failure_reason)) {
        await this.reconciliations.park(row.id, RECONCILIATION_DISPOSITION.PARKED_POISON);
        this.logger.warn({ event: 'reconciliation_drain_unknown_reason', ...base });
        return 'parked';
      }
      const klass = classifyReconciliation(row.failure_reason);

      switch (klass) {
        case 'EXCLUDED': {
          // Unreachable (the claim query excludes DUAL_CONTROL_PENDING); release
          // the lease and leave the row pending — never auto-touched to terminal.
          await this.reconciliations.bumpAttempt(
            row.id,
            new Date(Date.now() + ctx.backoffMs),
          );
          this.logger.warn({
            event: 'reconciliation_drain_excluded_claimed',
            class: klass,
            ...base,
          });
          return 'excluded';
        }
        case 'SUPERSEDED': {
          // A newer observation already applied — mark resolved, NO mutation.
          await this.reconciliations.markResolved(
            row.id,
            RECONCILIATION_DISPOSITION.RESOLVED_SUPERSEDED,
          );
          this.logger.log({
            event: 'reconciliation_drain_resolved',
            class: klass,
            disposition: RECONCILIATION_DISPOSITION.RESOLVED_SUPERSEDED,
            ...base,
          });
          return 'superseded';
        }
        case 'INTERVENTION': {
          // Never auto-execute; bump+backoff until the cap, then park for a human.
          return await this.parkOrBump(
            row,
            ctx,
            RECONCILIATION_DISPOSITION.PARKED_INTERVENTION,
            klass,
          );
        }
        case 'RE_EVALUABLE':
          return await this.reEvaluate(row, ctx, klass);
        default: {
          const unhandled: never = klass;
          throw new Error(`unhandled reconciliation class: ${String(unhandled)}`);
        }
      }
    } catch (err) {
      // Transient (DB / unexpected) failure — bump the attempt + backoff (park at
      // the cap). A single bad row never aborts the batch.
      const disposition = await this.parkOrBumpSafe(
        row,
        ctx,
        RECONCILIATION_DISPOSITION.PARKED_POISON,
      );
      this.logger.warn({
        event: 'reconciliation_drain_transient_failure',
        ...base,
        error_message: err instanceof Error ? err.message : String(err),
      });
      return disposition;
    }
  }

  // RE_EVALUABLE — the narrow governed re-attempt (R-REATTEMPT).
  private async reEvaluate(
    row: ClaimedReconciliationRow,
    ctx: DrainContext,
    klass: string,
  ): Promise<DrainRowOutcome> {
    const base = {
      tenant_id: row.tenant_id,
      connection_id: row.connection_id,
      provider_key: row.provider_key,
      external_req_id: row.external_req_id,
      reconciliation_id: row.id,
      failure_reason: row.failure_reason,
      class: klass,
      attempts: row.attempts,
    };

    // 1) Re-resolve identity. A null external_req_id, or an unresolved identity,
    //    is structurally NON-replayable -> park after bounded attempts, never a guess.
    if (row.external_req_id === null) {
      return this.parkOrBumpLogged(
        row,
        ctx,
        RECONCILIATION_DISPOSITION.PARKED_NON_REPLAYABLE,
        base,
      );
    }
    const requisitionId = await this.identities.resolve(
      row.tenant_id,
      row.connection_id,
      row.external_req_id,
    );
    if (requisitionId === null) {
      return this.parkOrBumpLogged(
        row,
        ctx,
        RECONCILIATION_DISPOSITION.PARKED_NON_REPLAYABLE,
        base,
      );
    }

    // 2) Re-resolve mapping on the normalized provider state. Still unmappable ->
    //    bounded re-attempt (poison at the cap).
    const normalized = row.normalized_status ?? this.normalize(row.raw_provider_status);
    const mapping = await this.mappings.findByConnectionState(
      row.tenant_id,
      row.connection_id,
      normalized,
    );
    if (mapping === null) {
      return this.parkOrBumpLogged(row, ctx, RECONCILIATION_DISPOSITION.PARKED_POISON, base);
    }
    const action = mapping.mapped_action as TransitionAction;
    if (!TRANSITION_ACTIONS.includes(action) || !isExternalLifecycleAction(action)) {
      // The mapping now names an unknown/human action — illegal external command;
      // park (intervention), never auto-execute.
      return this.parkOrBumpLogged(
        row,
        ctx,
        RECONCILIATION_DISPOSITION.PARKED_INTERVENTION,
        base,
      );
    }

    // 3) Reload (status, version). Threading version as expected_version makes a
    //    concurrent edit between reload and CAS surface as CAS_CONFLICT (no lost
    //    update) rather than clobbering. This is Aramo's OWN optimistic guard.
    const current = await this.requisitions.findStatusAndVersionById({
      tenant_id: row.tenant_id,
      id: requisitionId,
    });
    if (current === null) {
      return this.parkOrBumpLogged(
        row,
        ctx,
        RECONCILIATION_DISPOSITION.PARKED_NON_REPLAYABLE,
        base,
      );
    }

    // 4) Re-run the GOVERNED command seam as the connector service account.
    const command: ExternalLifecycleTransitionCommand = {
      tenant_id: row.tenant_id,
      requisition_id: requisitionId,
      action,
      actor_id: this.connectorPrincipalId,
      origin: 'integration',
      expected_version: current.version,
      external_provenance: {
        connection_id: row.connection_id,
        external_event_id: row.external_event_id,
        external_event_at: row.created_at.toISOString(),
        raw_provider_status: row.raw_provider_status,
        normalized_status: normalized,
        mapping_version: mapping.mapping_version,
        mapped_action: action,
      },
    };
    const result = await this.requisitions.executeExternalLifecycleCommand(command);

    if (result.outcome === 'EXECUTED') {
      // Link the governed transition to its external event (immutable provenance).
      await this.provenance.record({
        tenant_id: row.tenant_id,
        connection_id: row.connection_id,
        external_event_id: row.external_event_id,
        external_event_at: row.created_at,
        raw_provider_status: row.raw_provider_status,
        normalized_status: normalized,
        mapping_version: mapping.mapping_version,
        mapped_action: action,
        lifecycle_event_id: result.lifecycle_event_id,
        policy_decision_id: result.policy_decision_id,
      });
      await this.reconciliations.markResolved(
        row.id,
        RECONCILIATION_DISPOSITION.RESOLVED_REEVALUATED,
      );
      this.logger.log({
        event: 'reconciliation_drain_resolved',
        disposition: RECONCILIATION_DISPOSITION.RESOLVED_REEVALUATED,
        next_status: result.next_status,
        ...base,
      });
      return 'resolved';
    }

    // Governed refusal on re-attempt — re-classify by the returned reason.
    switch (result.reason) {
      case 'CAS_CONFLICT':
        // NO spin loop: one seam call per drain. Reschedule under the cap, then park.
        return this.parkOrBumpLogged(row, ctx, RECONCILIATION_DISPOSITION.PARKED_POISON, base);
      case 'ILLEGAL_FROM_STATE':
      case 'POLICY_DENIED':
        // A human/other transition legitimately changed the state — park (never
        // auto-execute), do not spin.
        await this.reconciliations.park(row.id, RECONCILIATION_DISPOSITION.PARKED_INTERVENTION);
        this.logger.log({
          event: 'reconciliation_drain_parked',
          disposition: RECONCILIATION_DISPOSITION.PARKED_INTERVENTION,
          refusal_reason: result.reason,
          ...base,
        });
        return 'parked';
      case 'REQUISITION_NOT_FOUND':
        return this.parkOrBumpLogged(
          row,
          ctx,
          RECONCILIATION_DISPOSITION.PARKED_NON_REPLAYABLE,
          base,
        );
      default: {
        const unhandled: never = result.reason;
        throw new Error(`unhandled external-lifecycle refusal reason: ${String(unhandled)}`);
      }
    }
  }

  // Reschedule (backoff) if attempts remain under the cap, else PARK (poison).
  private async parkOrBump(
    row: ClaimedReconciliationRow,
    ctx: DrainContext,
    parkDisposition: ReconciliationDisposition,
    klass: string,
  ): Promise<'parked' | 'rescheduled'> {
    if (row.attempts >= ctx.maxAttempts) {
      await this.reconciliations.park(row.id, parkDisposition);
      this.logger.log({
        event: 'reconciliation_drain_parked',
        class: klass,
        disposition: parkDisposition,
        reconciliation_id: row.id,
        tenant_id: row.tenant_id,
        connection_id: row.connection_id,
        failure_reason: row.failure_reason,
        attempts: row.attempts,
      });
      return 'parked';
    }
    await this.reconciliations.bumpAttempt(row.id, new Date(Date.now() + ctx.backoffMs));
    return 'rescheduled';
  }

  // parkOrBump with the RE_EVALUABLE base log fields threaded through.
  private async parkOrBumpLogged(
    row: ClaimedReconciliationRow,
    ctx: DrainContext,
    parkDisposition: ReconciliationDisposition,
    base: Record<string, unknown>,
  ): Promise<'parked' | 'rescheduled'> {
    if (row.attempts >= ctx.maxAttempts) {
      await this.reconciliations.park(row.id, parkDisposition);
      this.logger.log({
        event: 'reconciliation_drain_parked',
        disposition: parkDisposition,
        ...base,
      });
      return 'parked';
    }
    await this.reconciliations.bumpAttempt(row.id, new Date(Date.now() + ctx.backoffMs));
    this.logger.debug({ event: 'reconciliation_drain_rescheduled', ...base });
    return 'rescheduled';
  }

  // Best-effort park/bump for the transient catch — a failure to record the
  // disposition is swallowed (logged by the caller) so the batch never aborts.
  private async parkOrBumpSafe(
    row: ClaimedReconciliationRow,
    ctx: DrainContext,
    parkDisposition: ReconciliationDisposition,
  ): Promise<'parked' | 'rescheduled'> {
    try {
      if (row.attempts >= ctx.maxAttempts) {
        await this.reconciliations.park(row.id, parkDisposition);
        return 'parked';
      }
      await this.reconciliations.bumpAttempt(row.id, new Date(Date.now() + ctx.backoffMs));
      return 'rescheduled';
    } catch {
      // The lease will expire on its own; the next tick re-claims. Never rethrow.
      return 'rescheduled';
    }
  }
}
