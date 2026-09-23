// COMM-C4 (RCE-1) — a typed fail-closed refusal at the requisition-contact draft
// boundary. `reason` discriminates the authoritative-context failure; the
// controller maps this to COMMUNICATION_REQUISITION_CONTACT_CONTEXT_INVALID (422)
// with details.reason. The send path re-validates independently.

export type RequisitionContactContextReason =
  | 'requisition_not_found'
  | 'talent_not_associated_with_requisition';

export class RequisitionContactContextError extends Error {
  constructor(readonly reason: RequisitionContactContextReason) {
    super(`requisition-contact draft context invalid: ${reason}`);
    this.name = 'RequisitionContactContextError';
  }
}
