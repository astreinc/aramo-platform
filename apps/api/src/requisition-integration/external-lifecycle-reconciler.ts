import { Injectable, Logger } from '@nestjs/common';
import {
  RequisitionRepository,
  TRANSITION_ACTIONS,
  isExternalLifecycleAction,
  type ExternalLifecycleTransitionCommand,
  type TransitionAction,
} from '@aramo/requisition';
import {
  CONNECTOR_SERVICE_ACCOUNT_ID,
  MAPPING_DISPOSITION,
  RECONCILIATION_FAILURE_REASON,
  RequisitionLifecycleMappingRepository,
  RequisitionExternalReconciliationRepository,
  RequisitionExternalTransitionProvenanceRepository,
  normalizeProviderState,
} from '@aramo/integration';

import type { ExternalLifecycleEventInput } from './external-lifecycle-event.input.js';

// L1-D1 (ADR-0030 seam #6) — THE RECONCILER (orchestration seam).
//
// Composes the complete governed external-lifecycle path in apps/api (the
// connector-in-app composition ruling; all libs are scope:ats, so there is no
// I15 edge and no requisition->integration lib dependency — the two libs stay
// ignorant of each other and this layer binds them):
//
//   normalize -> mapping-contract lookup (per connection) -> authority mode ->
//   mapped ACTION -> (external_authority: call the @aramo/requisition command
//   seam) OR (dual_control: record a pending row, DO NOT execute) -> provenance.
//
// Anything unmappable / illegal-from-state / policy DENY / CAS conflict / not
// found -> the reconciliation queue (pending), NEVER a silent mutation.
//
// AUTHORITY (ADR-0030 seam #2 — the connector-actor-id check): this reconciler
// is the SOLE caller of the command seam and it ALWAYS acts as the connector
// service account (CONNECTOR_SERVICE_ACCOUNT_ID) — never a human, and never with
// requisition:edit. No HTTP route wires this seam, and the command seam itself
// rejects any non-integration origin. Humans transition through the ordinary
// PATCH pipeline (origin='ui'); they can never reach this path.
//
// HARD PROHIBITION: this file (and all connector/integration code) NEVER writes
// Requisition.status directly. The ONLY status-writing path from an external
// event is executeExternalLifecycleCommand (gate -> CAS -> atomic event).

export type ExternalLifecycleReconcilerResult =
  | {
      readonly outcome: 'EXECUTED';
      readonly next_status: string;
      readonly lifecycle_event_id: string;
      readonly policy_decision_id: string;
    }
  | { readonly outcome: 'RECONCILED'; readonly reason: string }
  // L1-D3-A (R3) — the active mapping deliberately IGNOREs this provider state:
  // an audited no-op (no mutation, no reconciliation row).
  | { readonly outcome: 'IGNORED'; readonly provider_state: string };

@Injectable()
export class ExternalLifecycleReconciler {
  private readonly logger = new Logger(ExternalLifecycleReconciler.name);

  // The connector service account — the ONLY principal this reconciler ever acts
  // as when invoking the governed command seam (never a human).
  readonly connectorPrincipalId = CONNECTOR_SERVICE_ACCOUNT_ID;

  constructor(
    private readonly requisitions: RequisitionRepository,
    private readonly mappings: RequisitionLifecycleMappingRepository,
    private readonly reconciliations: RequisitionExternalReconciliationRepository,
    private readonly provenance: RequisitionExternalTransitionProvenanceRepository,
  ) {}

  async ingest(
    input: ExternalLifecycleEventInput,
  ): Promise<ExternalLifecycleReconcilerResult> {
    // The SINGLE shared provider-state key normalizer (@aramo/integration) — the
    // mapping AUTHOR path and the drain use the same function, so an authored
    // 'Halted' matches an observed 'Halted'. (Was a private trim+lowercase.)
    const normalized = normalizeProviderState(input.raw_provider_status);
    const currentStatus = await this.requisitions.findStatusById({
      tenant_id: input.tenant_id,
      id: input.requisition_id,
    });

    // 1) Mapping lookup via the connection's ACTIVE mapping set (L1-D3-A). No
    //    active set / no row for the state -> unmappable.
    const mapping = await this.mappings.findByConnectionState(
      input.tenant_id,
      input.connection_id,
      normalized,
    );
    if (mapping === null) {
      return this.reconcile(input, {
        failure_reason: RECONCILIATION_FAILURE_REASON.UNMAPPABLE_PROVIDER_STATE,
        normalized_status: normalized,
        mapped_action: null,
        current_aramo_status: currentStatus,
      });
    }

    // 2) L1-D3-A (R3) — IGNORE disposition: the tenant deliberately asserts this
    //    provider state carries NO Lane-1 lifecycle authority. Audited no-op —
    //    NO governed command, NO reconciliation row, NO mutation.
    if (mapping.disposition === MAPPING_DISPOSITION.IGNORE) {
      this.logger.debug(
        `external lifecycle event IGNORED by active mapping (state=${normalized})`,
      );
      return { outcome: 'IGNORED', provider_state: normalized };
    }

    // 3) EXECUTE_ACTION — the mapped action must be a known OPERATIONAL lifecycle
    //    action. A mapping with no action (defensive) or an unknown / human
    //    approval action is an illegal external command -> reconciliation.
    if (mapping.mapped_action === null) {
      return this.reconcile(input, {
        failure_reason: RECONCILIATION_FAILURE_REASON.ILLEGAL_FROM_STATE,
        normalized_status: normalized,
        mapped_action: null,
        current_aramo_status: currentStatus,
      });
    }
    const action = mapping.mapped_action as TransitionAction;
    if (!TRANSITION_ACTIONS.includes(action) || !isExternalLifecycleAction(action)) {
      return this.reconcile(input, {
        failure_reason: RECONCILIATION_FAILURE_REASON.ILLEGAL_FROM_STATE,
        normalized_status: normalized,
        mapped_action: mapping.mapped_action,
        current_aramo_status: currentStatus,
      });
    }

    // 4) Authority mode. dual_control RECORDS intent and does NOT execute.
    if (mapping.authority_mode === 'dual_control') {
      return this.reconcile(input, {
        failure_reason: RECONCILIATION_FAILURE_REASON.DUAL_CONTROL_PENDING,
        normalized_status: normalized,
        mapped_action: action,
        current_aramo_status: currentStatus,
      });
    }

    // 5) external_authority — invoke the GOVERNED command seam as the connector
    //    service account. This is the ONLY status-writing path.
    const command: ExternalLifecycleTransitionCommand = {
      tenant_id: input.tenant_id,
      requisition_id: input.requisition_id,
      action,
      actor_id: this.connectorPrincipalId,
      origin: 'integration',
      ...(input.expected_version === undefined
        ? {}
        : { expected_version: input.expected_version }),
      external_provenance: {
        connection_id: input.connection_id,
        external_event_id: input.external_event_id,
        external_event_at: input.external_event_at,
        raw_provider_status: input.raw_provider_status,
        normalized_status: normalized,
        mapping_version: mapping.mapping_version,
        mapped_action: action,
      },
    };
    const result = await this.requisitions.executeExternalLifecycleCommand(command);

    if (result.outcome === 'EXECUTED') {
      // 6) Structured external provenance links the governed transition to its
      //    external event (immutable record). mapping_version is the ACTIVE
      //    mapping set's version (L1-D3-A — provenance identifies the exact
      //    configuration that caused the transition).
      await this.provenance.record({
        tenant_id: input.tenant_id,
        connection_id: input.connection_id,
        external_event_id: input.external_event_id,
        external_event_at: new Date(input.external_event_at),
        raw_provider_status: input.raw_provider_status,
        normalized_status: normalized,
        mapping_version: mapping.mapping_version,
        mapped_action: action,
        lifecycle_event_id: result.lifecycle_event_id,
        policy_decision_id: result.policy_decision_id,
      });
      return {
        outcome: 'EXECUTED',
        next_status: result.next_status,
        lifecycle_event_id: result.lifecycle_event_id,
        policy_decision_id: result.policy_decision_id,
      };
    }

    // Governed refusal (illegal-from-state / policy DENY / CAS conflict / not
    // found) -> reconciliation, NO mutation.
    return this.reconcile(input, {
      failure_reason: result.reason,
      normalized_status: normalized,
      mapped_action: action,
      current_aramo_status: result.current_status,
    });
  }

  // Record one pending reconciliation row and return the RECONCILED outcome.
  private async reconcile(
    input: ExternalLifecycleEventInput,
    detail: {
      failure_reason: string;
      normalized_status: string | null;
      mapped_action: string | null;
      current_aramo_status: string | null;
    },
  ): Promise<ExternalLifecycleReconcilerResult> {
    await this.reconciliations.recordPending({
      tenant_id: input.tenant_id,
      connection_id: input.connection_id,
      external_event_id: input.external_event_id,
      external_req_id: input.external_req_id ?? null,
      provider_key: input.provider_key,
      raw_provider_status: input.raw_provider_status,
      normalized_status: detail.normalized_status,
      mapped_action: detail.mapped_action,
      current_aramo_status: detail.current_aramo_status,
      failure_reason: detail.failure_reason,
    });
    this.logger.debug(
      `external lifecycle event routed to reconciliation: ${detail.failure_reason}`,
    );
    return { outcome: 'RECONCILED', reason: detail.failure_reason };
  }
}
