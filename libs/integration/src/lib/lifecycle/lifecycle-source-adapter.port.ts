// CB-D2-A1 (ADR-0030) — the provider-NEUTRAL lifecycle-source adapter port +
// two-concept canonical model. This is DISTINCT from the CREATE-only
// `ConnectorAdapter` (connector-adapter.port.ts), which is hard-typed to
// `CanonicalRequisitionImportRecord` and can ONLY import new requisitions — it
// cannot carry lifecycle observations/events. A1 ships NO real provider adapter;
// a FAKE lifecycle source proves the port (a Fieldglass/Workday/iLabor runtime is
// a later slice).

// R-ORDER (A0-R4) — the ordering-confidence class of an observation/event.
// Provider ordering is ⊥ Requisition.version (never mapped onto expected_version):
//   - 'strong'  — a provider monotonic sequence (stale-rejection authoritative);
//   - 'bounded' — a documented cursor/order (stale-rejection authoritative);
//   - 'weak'    — timestamp + deterministic tie-break (process only when safely
//                 compatible; ambiguous → reconciliation);
//   - 'unknown' — none (treat as an OBSERVATION of state, never proof of causal
//                 order — the default for a Fieldglass state pull).
export type LifecycleOrderingConfidence = 'strong' | 'bounded' | 'weak' | 'unknown';

export const LIFECYCLE_ORDERING_CONFIDENCES: readonly LifecycleOrderingConfidence[] = [
  'strong',
  'bounded',
  'weak',
  'unknown',
];

// A durably-identified provider fetch (poll/webhook delivery). The `delivery_id`
// is the provider-neutral identity of ONE fetch (A0-R5) — reused on retry, new on
// the next poll.
export interface LifecycleDelivery {
  readonly delivery_id: string;
  /** When Aramo received this delivery (never a provider event timestamp). */
  readonly received_at: string;
}

// ExternalRequisitionLifecycleObservation — a STATE observation (e.g. a Fieldglass
// pull). It asserts "the external requisition is CURRENTLY in this state", not
// "this event happened at time T". `observed_at` is Aramo time; there is NO
// provider event timestamp and NO provider sequence — confidence is 'unknown'.
export interface ExternalRequisitionLifecycleObservation {
  readonly kind: 'observation';
  readonly external_req_id: string;
  readonly observed_status: string;
  /** Aramo observation time (ISO-8601). NEVER labelled a provider event timestamp. */
  readonly observed_at: string;
  readonly provider_event_at: null;
  readonly provider_sequence: null;
  readonly ordering_confidence: 'unknown';
}

// ExternalRequisitionLifecycleEvent — an event-capable fact (e.g. Workday, if
// gated in). It carries the provider's own event identity + timestamp and an
// optional provider sequence, with a real ordering-confidence class.
export interface ExternalRequisitionLifecycleEvent {
  readonly kind: 'event';
  readonly external_req_id: string;
  readonly external_event_id: string;
  readonly observed_status: string;
  /** The provider's event timestamp (ISO-8601). */
  readonly provider_event_at: string;
  readonly provider_sequence: number | null;
  readonly ordering_confidence: 'strong' | 'bounded' | 'weak';
}

export type LifecycleChange =
  | ExternalRequisitionLifecycleObservation
  | ExternalRequisitionLifecycleEvent;

// The tenant-bound execution context handed to a lifecycle source (mirrors
// ConnectorExecutionContext; the credential is resolved server-side, ephemeral).
export interface LifecycleFetchContext {
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly provider_key: string;
  readonly cursor: string | null;
  readonly credential: string | null;
}

// The result of ONE lifecycle fetch: a durable delivery + its changes + an
// optional advanced cursor (persisted ONLY after successful processing).
export interface LifecycleFetchResult {
  readonly delivery: LifecycleDelivery;
  readonly changes: readonly LifecycleChange[];
  readonly next_cursor?: string | null;
}

export interface LifecycleSourceAdapter {
  /** Extensible provider key — NEVER a frozen vendor enum. */
  readonly providerKey: string;
  /** Fetch the lifecycle changes since the connection's cursor/watermark. */
  fetchLifecycleChanges(ctx: LifecycleFetchContext): Promise<LifecycleFetchResult>;
}

// The durable observation identity (A0-R5): a per-observation key so a
// redelivery of the SAME delivery collides, while the NEXT poll (new delivery_id)
// re-observing the same requisition is NOT collapsed. For an event, the provider
// external_event_id is already durable and is used directly.
export function observationKeyFor(
  deliveryId: string,
  change: LifecycleChange,
): string {
  return change.kind === 'event'
    ? change.external_event_id
    : `${deliveryId}:${change.external_req_id}`;
}
