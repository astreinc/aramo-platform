// L1-D1 (ADR-0030) — R-INGRESS. The TYPED test/stub ingress fed DIRECTLY into
// the orchestration seam (ExternalLifecycleReconciler) in integration tests. It
// is NOT a production connector abstraction pretending to be a provider: D1
// builds NO live provider polling / webhook / adapter runtime and NO
// queue-draining worker (all D2). This is the shape a real Connector-B event is
// normalized INTO before the reconciler composes mapping -> authority -> command.
export interface ExternalLifecycleEventInput {
  readonly tenant_id: string;
  // The IntegrationConnection this event arrived on (the account identity).
  readonly connection_id: string;
  readonly provider_key: string;
  // The provider's idempotency identity for this event (D2 dedupes on it).
  readonly external_event_id: string;
  // The external requisition identifier (opaque provider id), for reconciliation
  // traceability. Optional in D1 (the internal requisition_id is resolved ahead).
  readonly external_req_id?: string;
  // The resolved INTERNAL requisition id. D1 supplies it directly; D2 resolves it
  // from (connection, external_req_id) via the external-identity index.
  readonly requisition_id: string;
  // The provider's lifecycle-event timestamp (ISO-8601).
  readonly external_event_at: string;
  // The RAW provider lifecycle state token (normalized inside the reconciler).
  readonly raw_provider_status: string;
  // Optional optimistic-concurrency guard (the external event's believed
  // version). A stale value routes the governed command to reconciliation — no
  // lost update. D2 derives this from provider ordering/watermarks.
  readonly expected_version?: number;
}
