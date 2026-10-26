// CCP-C8-PR — GET /platform/commercial/contracts/{id}/payments (Aramo-CCP-Program-Build-Directive-
// Amendment-A2-Payment-Record-v1_0-LOCKED PR-10, PR-11). The derived payment status of a contract's
// obligations, and its receipt records (history kept). Amounts, the payment terms and the receipt evidence
// are sent only to a caller holding platform:billing:read AND platform:billing:amount:read; any other
// billing reader gets the statuses and the payment_due / payment_overdue booleans only (FA-4), with
// amount_withheld.

export type ObligationPaymentStatusDto = 'PAID' | 'NOT_DUE' | 'DUE' | 'PAST_DUE';

export interface ContractObligationPaymentDto {
  obligation_ref: string;
  due_date: string;
  status: ObligationPaymentStatusDto;
  /** Holders only. */
  description?: string;
  amount_minor?: number;
  currency?: string;
  effective_receipt_id?: string | null;
}

export interface ContractPaymentRecordDto {
  id: string;
  change_request_id: string;
  entry_kind: 'RECORD' | 'CORRECTION';
  corrects_receipt_id: string | null;
  obligation_ref: string | null;
  external_invoice_ref: string;
  amount_minor: number;
  currency: string;
  received_on: string;
  payment_method: string;
  payment_reference: string;
  verification: string | null;
  evidence_documents: Array<{ name: string; sha256: string; byte_size?: number; media_type?: string }>;
  origin: string;
  recorded_by: string;
  recorded_at: string;
  linked_at: string | null;
  corrected_at: string | null;
  corrected_by_change_request_id: string | null;
  effective: boolean;
}

export interface ContractPaymentsResponseDto {
  contract_id: string;
  contract_ref: string;
  as_of: string;
  /** Today in the contract timezone (null for a contract recorded without payment terms). */
  as_of_date: string | null;
  payment_due: boolean;
  payment_overdue: boolean;
  obligations: ContractObligationPaymentDto[];
  /** Holders only. */
  payment_terms?: { billing_mode: string; currency: string; timezone: string; grace_days: number | null; effective_grace_days: number; postpaid_approval: unknown } | null;
  records?: ContractPaymentRecordDto[];
  /** Non-holders: the amounts, terms and records are omitted. */
  amount_withheld?: 'FINANCE_SCOPE_REQUIRED';
}
