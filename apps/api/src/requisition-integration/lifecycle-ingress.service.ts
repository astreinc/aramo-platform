import { Injectable, Logger } from '@nestjs/common';
import {
  ExternalRequisitionIdentityRepository,
  LifecycleObservationLedgerRepository,
  RequisitionExternalReconciliationRepository,
  observationKeyFor,
  type LifecycleChange,
} from '@aramo/integration';

import { ExternalLifecycleReconciler } from './external-lifecycle-reconciler.js';

// CB-D2-A1 (ADR-0030 seam #6, R-MAP) — the provider-NEUTRAL lifecycle ingress
// mapper. It sits BETWEEN a provider-neutral observation/event and the L1-D1
// governed command seam and it REUSES that seam (ExternalLifecycleReconciler),
// never forks it. The order is load-bearing:
//
//   1. RAW-PERSIST + DEDUP (R-DURABILITY + A0-R5): reserve the observation in the
//      lifecycle ledger BEFORE any command. The row is the idempotency authority
//      (unique observation_key) — a redelivered SAME observation yields ONE
//      outcome; a NEW delivery re-observing the same requisition is a NEW row (not
//      collapsed).
//   2. IDENTITY RESOLVE (R-IDENTITY): (tenant, connection_id, external_req_id) →
//      requisition_id. Unresolved → reconciliation (REQUISITION_NOT_FOUND),
//      NEVER a guess from source_system.
//   3. ORDERING (R-ORDER / A0-R4): STRONG/BOUNDED with a provider_sequence <= the
//      last ACCEPTED sequence → stale-rejection is authoritative → reconciliation;
//      WEAK/UNKNOWN out-of-apparent-order (earlier than the last accepted) →
//      ambiguous → reconciliation, never a blind overwrite.
//   4. NORMALIZE → the EXISTING ExternalLifecycleEventInput. expected_version is
//      OMITTED (observation-mode) — provider ordering is ⊥ Requisition.version, so
//      a provider_sequence is NEVER mapped onto the CAS predicate (CAS SEPARATION).
//   5. reconciler.ingest → governed command OR reconciliation.
//
// HARD PROHIBITION: this file writes NO requisition state. The only status-writing
// path is the reconciler's executeExternalLifecycleCommand (gate → CAS → event).

export interface LifecycleIngressParams {
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly provider_key: string;
  readonly delivery_id: string;
  readonly change: LifecycleChange;
}

export type LifecycleIngressOutcome =
  | { readonly outcome: 'EXECUTED'; readonly next_status: string }
  | { readonly outcome: 'RECONCILED'; readonly reason: string }
  | { readonly outcome: 'DUPLICATE' };

@Injectable()
export class LifecycleIngressService {
  private readonly logger = new Logger(LifecycleIngressService.name);

  constructor(
    private readonly reconciler: ExternalLifecycleReconciler,
    private readonly ledger: LifecycleObservationLedgerRepository,
    private readonly identities: ExternalRequisitionIdentityRepository,
    private readonly reconciliations: RequisitionExternalReconciliationRepository,
  ) {}

  async ingest(params: LifecycleIngressParams): Promise<LifecycleIngressOutcome> {
    const { tenant_id, connection_id, provider_key, delivery_id, change } = params;
    const observationKey = observationKeyFor(delivery_id, change);
    const providerEventAt =
      change.kind === 'event' ? new Date(change.provider_event_at) : null;
    // observed_at is ALWAYS Aramo time. For an observation it is the pull time;
    // for an event it is the Aramo receipt time (the provider's own timestamp
    // lives in provider_event_at — never conflated).
    const observedAt =
      change.kind === 'observation' ? new Date(change.observed_at) : new Date();

    // 1. RAW-PERSIST + DEDUP. The reserve is the durable, replay-safe record that
    //    pre-exists any command (R-DURABILITY) and the idempotency authority.
    const reservation = await this.ledger.reserve({
      tenant_id,
      connection_id,
      external_req_id: change.external_req_id,
      observation_key: observationKey,
      raw_provider_status: change.observed_status,
      ordering_confidence: change.ordering_confidence,
      provider_sequence: change.provider_sequence,
      provider_event_at: providerEventAt,
      observed_at: observedAt,
    });
    if (!reservation.reserved) {
      const st = reservation.row.status;
      if (st === 'processed' || st === 'reconciled') {
        // A redelivered SAME observation → ONE outcome (A0-R5). Not reprocessed.
        return { outcome: 'DUPLICATE' };
      }
      // A prior attempt crashed mid-flight (status 'pending') → replay it.
    }
    const ledgerId = reservation.row.id;

    // 2. IDENTITY RESOLVE (connection-scoped). Unresolved → reconciliation.
    const requisitionId = await this.identities.resolve(
      tenant_id,
      connection_id,
      change.external_req_id,
    );
    if (requisitionId === null) {
      return this.reconcile(params, ledgerId, observationKey, 'REQUISITION_NOT_FOUND', null);
    }

    // 3. ORDERING (R-ORDER). Only ACCEPTED (executed) prior observations count.
    const last = await this.ledger.lastAcceptedFor(
      tenant_id,
      connection_id,
      change.external_req_id,
    );
    if (last !== null) {
      const strong =
        change.ordering_confidence === 'strong' || change.ordering_confidence === 'bounded';
      if (
        strong &&
        change.provider_sequence !== null &&
        last.provider_sequence !== null &&
        change.provider_sequence <= last.provider_sequence
      ) {
        // STRONG/BOUNDED: a provider-authoritative sequence proves this is stale.
        return this.reconcile(params, ledgerId, observationKey, 'ORDERING_STALE', requisitionId);
      }
      if (!strong) {
        // WEAK/UNKNOWN: no authoritative order. An input that appears EARLIER than
        // the last accepted is ambiguous → reconciliation, never a blind overwrite.
        const lastWhen = last.provider_event_at ?? last.observed_at;
        const thisWhen = providerEventAt ?? observedAt;
        if (thisWhen.getTime() < lastWhen.getTime()) {
          return this.reconcile(
            params,
            ledgerId,
            observationKey,
            'ORDERING_AMBIGUOUS',
            requisitionId,
          );
        }
      }
    }

    // 4. NORMALIZE to the EXISTING ExternalLifecycleEventInput. expected_version is
    //    deliberately OMITTED — provider ordering never sets Requisition.version.
    const externalEventId =
      change.kind === 'event' ? change.external_event_id : observationKey;
    const externalEventAt =
      change.kind === 'event' ? change.provider_event_at : observedAt.toISOString();

    // 5. Reuse the L1-D1 governed seam.
    const result = await this.reconciler.ingest({
      tenant_id,
      connection_id,
      provider_key,
      external_event_id: externalEventId,
      external_req_id: change.external_req_id,
      requisition_id: requisitionId,
      external_event_at: externalEventAt,
      raw_provider_status: change.observed_status,
    });

    if (result.outcome === 'EXECUTED') {
      // ACCEPTED — this observation becomes the ordering high-water mark.
      await this.ledger.markProcessed(ledgerId, 'EXECUTED');
      return { outcome: 'EXECUTED', next_status: result.next_status };
    }
    // A governed refusal (the reconciler already wrote the reconciliation row).
    // Mark the ledger reconciled (NOT accepted) so it never counts as ordering
    // high-water and a redelivery is a benign duplicate.
    await this.ledger.markReconciled(ledgerId, result.reason);
    return { outcome: 'RECONCILED', reason: result.reason };
  }

  // Route an ingress-level refusal (unresolved identity / stale / ambiguous
  // ordering) to the reconciliation queue and mark the ledger row reconciled.
  // These never reach the governed command (there is no requisition to command,
  // or the input is provably stale), so the reconciliation row is written here.
  private async reconcile(
    params: LifecycleIngressParams,
    ledgerId: string,
    observationKey: string,
    reason: string,
    requisitionId: string | null,
  ): Promise<LifecycleIngressOutcome> {
    const currentStatus =
      requisitionId === null
        ? null
        : // The reconciler owns requisition reads; the ingress-level refusals
          // record the external facts only (current status is filled by D2 drain).
          null;
    await this.reconciliations.recordPending({
      tenant_id: params.tenant_id,
      connection_id: params.connection_id,
      external_event_id: observationKey,
      external_req_id: params.change.external_req_id,
      provider_key: params.provider_key,
      raw_provider_status: params.change.observed_status,
      normalized_status: null,
      mapped_action: null,
      current_aramo_status: currentStatus,
      failure_reason: reason,
    });
    await this.ledger.markReconciled(ledgerId, reason);
    this.logger.debug(`lifecycle observation routed to reconciliation: ${reason}`);
    return { outcome: 'RECONCILED', reason };
  }
}
