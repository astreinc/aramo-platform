// CI-B3 — the conversation-transcript-OWNED CommunicationInteraction existence
// read-port (mirrors the communications RequisitionExistencePort pattern).
// conversation-transcript references an interaction by UUID ONLY; it must NEVER
// import @aramo/communications (that would create a forbidden nx edge and would
// duplicate Communications interaction authority — directive §3.1/§3.3). The
// composition root (apps/api) binds a concrete reader, where the communications
// read is a legal composition-root import.
//
// The check is tenant-safe: an interaction from another tenant is "does not
// exist" for this caller (directive §28 tenant isolation).

/** Tenant-safe existence check for a referenced CommunicationInteraction. */
export interface InteractionReferencePort {
  /** True iff a CommunicationInteraction `interactionId` exists within `tenantId`. */
  existsInTenant(tenantId: string, interactionId: string): Promise<boolean>;
}

/** DI token for the port; the concrete reader is bound at the composition root. */
export const INTERACTION_REFERENCE_PORT = 'INTERACTION_REFERENCE_PORT';
