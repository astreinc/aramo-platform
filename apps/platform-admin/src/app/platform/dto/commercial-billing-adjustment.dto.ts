import type { BillingCommandDto } from './commercial-billing.dto.js';

// CCP-C4 — the billing-adjustment state of a CREDIT / DISCOUNT / REFUND change request
// (POST …/{id}/billing-adjustment, GET …/{id}/billing-adjustment). `pending_provider` is true while
// a Stripe-owned operation of the request is not provider-confirmed (Conv. C-23). Finance amount
// interim (decisions TD-C3-5 ruling): no tenant-specific amount is returned; each removed amount is
// marked `amount_withheld: "FINANCE_SCOPE_PENDING"`. A discount percentage is not an amount.

export interface BillingAdjustmentRecordDto {
  id: string;
  change_request_id: string;
  // CREDIT | DISCOUNT | REFUND
  action_type: string;
  // CREDIT_GRANT | CREDIT_REVERSE | DISCOUNT_APPLY | DISCOUNT_REMOVE | REFUND_CREATE
  operation: string;
  tenant_id: string;
  product_key: string;
  subscription_id: string;
  provider: string;
  provider_target_ref: string;
  provider_object_ref: string | null;
  discount_bps: number | null;
  compensates_change_request_id: string | null;
  command_id: string;
  // WEBHOOK | REFETCH
  confirmation_source: string;
  confirmation_event_id: string | null;
  attempt: number;
  requested_by: string;
  applied_at: string;
  amount_withheld?: 'FINANCE_SCOPE_PENDING';
}

export interface BillingAdjustmentDto {
  // CREDIT_GRANT | CREDIT_REVERSE | DISCOUNT_APPLY | DISCOUNT_REMOVE | REFUND_CREATE (null: unreadable payload)
  operation: string | null;
  // NOT_APPLIED | APPLY_FAILED | PENDING_PROVIDER | COMMAND_FAILED | APPLIED
  status: string;
  pending_provider: boolean;
  // true for a REFUND while the refund policy is not approved (the designed disabled state, PBD §10)
  refund_execution_disabled: boolean;
  commands: BillingCommandDto[];
  record: BillingAdjustmentRecordDto | null;
}
