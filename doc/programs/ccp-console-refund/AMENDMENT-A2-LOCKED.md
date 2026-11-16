# Aramo CCP — Console Refund Request Directive, Amendment A2: Commercial Ops Requester v1.0 (LOCKED)

**Status:** LOCKED — PO ruling 2026-11-16 ("Let's implement" the enterprise refund flow). Fast track.
**Amends:** Aramo-CCP-Console-Refund-Request-Directive-v1_0-LOCKED (`93b3365e…6f50`) §4 Q3.
**Withdraws:** Aramo-CCP-Console-Refund-Request-Directive-Amendment-A1-Finance-Requester-v1_0-LOCKED (`bf347996…413a`) in full — no grant of `platform:billing:request` to `finance_admin`; CCP-A1-A2 PS-3 and CCP-A1 INV-2 stand unchanged. The refund policy v1.1 draft (2026-11-16) is withdrawn; ARAMO-COM-REFUND-POL-001 v1.0 governs unchanged.

## A2-1 The flow (final)
| Stage | Who | System |
|---|---|---|
| 1. Intake | Support (support@ mailbox / ticket) | Outside the console; the ticket reference is the evidence |
| 2. Request | **Commercial ops** (`commercial_ops`, `platform:billing:request`) | Tenant › Commercial › "Request refund…" creates and submits a `REFUND` change request |
| 3. Approve | **Finance Admin** | Finance step |
| 4. Approve | **Platform Owner** | Owner step |
| 5. Apply | **The requester** (Commercial ops) | `…/billing-adjustment`; Stripe executes; the webhook confirms |
| 6. Close | Support | Replies to the account holder |
Chain `FINANCE_THEN_OWNER` (refund policy v1.0 §5, TD-C4-2), distinct humans, requester-only apply (CCP-C4): all unchanged.

## A2-2 Console requester
The "Request refund…" action is offered to a holder of `platform:billing:read` AND `platform:billing:request` (today `commercial_ops` only), on an open self-service row, while the ACTIVE commercial policy declares the refund keys.

## A2-3 Narrow FA-1 exception
`GET /platform/commercial/tenants/{tenant_id}/refundable-payments` is readable by a Finance amount holder (`platform:billing:amount:read`) OR the refund requester (`platform:billing:request`). The requester authors the refund amount, so it may see the paid amount, refunds, reservations and remainder of that tenant's payments **on this route only**. Every other CCP-R3 amount rule (billing status, reports, exports, change-request reads) is unchanged.

## A2-4 Operations
The requester account is a new mailbox (`billing@aramo.ai`) invited by the Platform Owner directly as Commercial ops (CCP-INV-UI-1; a new member needs no ROLE_GRANT). support@ keeps `finance_admin` as a backup Finance signer (removal needs a second Platform Owner; recorded, not actioned). All role accounts are aliases of one human (interim ruling 2026-10-26); their approvals are not independent review.
