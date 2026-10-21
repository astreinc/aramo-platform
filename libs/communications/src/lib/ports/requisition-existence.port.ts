// COMM-B5 — the Communications-OWNED requisition existence read-port
// (R-COMM-REQ-BOUNDARY). Communications may associate a call with a requisition
// (`regarding`) by UUID reference ONLY; it must NEVER import @aramo/requisition
// (that would create the forbidden nx edge). This port is the contract the
// composition root binds to a concrete reader living in apps/api, where the
// requisition read is a legal composition-root import. The check is tenant-safe:
// a requisition from another tenant is "does not exist" for this caller.

/** Tenant-safe existence check for an optional `regarding` requisition. */
export interface RequisitionExistencePort {
  /** True iff a requisition with `requisitionId` exists within `tenantId`. */
  exists(tenantId: string, requisitionId: string): Promise<boolean>;
  /**
   * Talent Lifecycle R1–R5 Impl Directive v1.2 §5.6 — the requisition's current status
   * (null when it does not resolve in `tenantId`), for the pre-send CONTACT_SEND gate.
   */
  findStatus(tenantId: string, requisitionId: string): Promise<string | null>;
}

/** DI token for the port; the concrete reader is bound at the composition root. */
export const REQUISITION_EXISTENCE_PORT = 'REQUISITION_EXISTENCE_PORT';
