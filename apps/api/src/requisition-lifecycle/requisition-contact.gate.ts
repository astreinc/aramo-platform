import { AramoError } from '@aramo/common';
import { requisitionPermits } from '@aramo/pipeline';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 LOCKED §5.6 (A1 AM-1 §2.2, D-3) — the
// PRE-SEND gate for NEW contact made THROUGH a requisition: requisition-scoped email, voice
// call, and RTR request / send / remind. External sends cannot hold a database lock (T-4),
// so the status is checked immediately before the send; the evidence write that follows is
// gated again inside its own transaction (§5.3). Talent communications NOT tied to a
// requisition are unaffected (D-3) — callers invoke this only when a requisition is in scope.
//
// Denied on closed / canceled (and nothing else today: lead permits CONTACT_SEND under the
// provisional D-2 ruling). A requisition that does not resolve in the tenant is refused
// (fail-closed, §2.6).

export interface RequisitionStatusReader {
  findStatusById(args: { tenant_id: string; id: string }): Promise<string | null>;
}

export async function assertRequisitionPermitsContactSend(
  requisitions: RequisitionStatusReader,
  args: { tenant_id: string; requisition_id: string; requestId: string },
): Promise<void> {
  const status = await requisitions.findStatusById({ tenant_id: args.tenant_id, id: args.requisition_id });
  if (status === null || !requisitionPermits(status, 'CONTACT_SEND')) {
    throw new AramoError(
      'REQUISITION_NOT_ADVANCEABLE',
      'New contact through this requisition is not permitted in its current status',
      409,
      {
        requestId: args.requestId,
        details: { requisition_id: args.requisition_id, status, activity: 'CONTACT_SEND' },
      },
    );
  }
}
