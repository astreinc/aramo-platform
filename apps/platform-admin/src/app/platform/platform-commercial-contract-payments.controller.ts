import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { ContractPaymentReadService, type ContractPaymentsView } from '@aramo/subscription';

import type { ContractPaymentRecordDto, ContractPaymentsResponseDto } from './dto/commercial-contract-payments.dto.js';
import { amountAccess } from './finance-amount-access.js';

// CCP-C8-PR (Aramo-CCP-Program-Build-Directive-Amendment-A2-Payment-Record-v1_0-LOCKED PR-10, PR-11) —
// READ-ONLY: a contract's obligations with their derived payment status (calendar dates in the contract
// timezone) and its receipt records. Payments are recorded only through the governed change-request routes
// (PAYMENT_RECORD); this controller writes nothing and never sets TenantSubscription.status.
//
// Gate `platform:billing:read` (platform_owner, finance_admin, commercial_ops, support_admin,
// read_only_auditor; NOT catalog_manager, NOT super_admin). Field authorization (FA-1 / FA-5, PR-11): the
// amounts, the payment terms and the receipt evidence go only to a holder of platform:billing:amount:read
// as well; every other billing reader gets the statuses and the payment_due / payment_overdue booleans.

@Controller('platform/commercial/contracts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialContractPaymentsController {
  constructor(private readonly payments: ContractPaymentReadService) {}

  @Get(':id/payments')
  @RequireScopes('platform:billing:read')
  async contractPayments(@Param('id', new ParseUUIDPipe()) id: string, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<ContractPaymentsResponseDto> {
    if (auth.consumer_type !== 'platform') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, { requestId, details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type } });
    }
    const v = await this.payments.contractPayments(id);
    if (v === null) throw new AramoError('NOT_FOUND', 'Contract not found', 404, { requestId, details: { contract_id: id } });
    return contractPaymentsDto(v, amountAccess(auth));
  }
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** PR-11 — the holder's full view, or the status-and-booleans view (FA-4) with amount_withheld. */
export function contractPaymentsDto(v: ContractPaymentsView, amount_access: boolean): ContractPaymentsResponseDto {
  const base = { contract_id: v.contract_id, contract_ref: v.contract_ref, as_of: v.as_of.toISOString(), as_of_date: v.as_of_date, payment_due: v.payment_due, payment_overdue: v.payment_overdue };
  if (!amount_access) {
    return { ...base, obligations: v.obligations.map((o) => ({ obligation_ref: o.obligation_ref, due_date: o.due_date, status: o.status })), amount_withheld: 'FINANCE_SCOPE_REQUIRED' };
  }
  return {
    ...base,
    payment_terms: v.payment_terms,
    obligations: v.obligations.map((o) => ({ obligation_ref: o.obligation_ref, due_date: o.due_date, status: o.status, description: o.description, amount_minor: o.amount_minor, currency: o.currency, effective_receipt_id: o.effective_receipt_id })),
    records: v.records.map(
      (r): ContractPaymentRecordDto => ({
        ...r,
        evidence_documents: r.evidence_documents as ContractPaymentRecordDto['evidence_documents'],
        recorded_at: r.recorded_at.toISOString(),
        linked_at: iso(r.linked_at),
        corrected_at: iso(r.corrected_at),
      }),
    ),
  };
}
