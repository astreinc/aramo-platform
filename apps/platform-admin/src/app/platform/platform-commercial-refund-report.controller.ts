import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { CommercialRefundReportService, RefundReportQueryError, evidenceVisible, type FinanceReader, type RefundReportRow } from '@aramo/subscription';

import { financeReader } from './finance-amount-access.js';
import { RefundReportQueryDto, type RefundReportResponseDto, type RefundReportRowDto } from './dto/commercial-refund-report.dto.js';

// CCP-C4-P (Amendment A1 RF-2, RF-10; Architect C4-P gap 3) — GET /platform/commercial/finance/refunds:
// the READ-ONLY refund report, projected from the existing records (no ledger table). Route gate
// platform:billing:read (platform_owner, finance_admin, commercial_ops, support_admin,
// read_only_auditor; never catalog_manager, never super_admin). The amount is a monetary figure
// (RF-10): returned only to a caller holding platform:billing:amount:read, otherwise omitted with
// `amount_withheld: "FINANCE_SCOPE_REQUIRED"` (backend-enforced; never sent for the UI to hide).
// Merge train TD-C4P-6: the decision is CCP-R3's shared amountAccess (platform:billing:read AND
// platform:billing:amount:read), replacing C4-P's local check.
// Platform consumer only. No mutation.
// CCP-R3-W (Architect W-3): `category` is the REFUND's requester-authored provenance (payload
// evidence, RF-2). Without the Finance amount scope it is returned only on the caller's OWN request;
// on anyone else's it is omitted with `evidence_withheld: "FINANCE_SCOPE_REQUIRED"`.

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function refundReportRowDto(r: RefundReportRow, reader: FinanceReader): RefundReportRowDto {
  const amounts = reader.amount_access;
  return {
    change_request_id: r.change_request_id,
    tenant_id: r.tenant_id,
    product_key: r.product_key,
    request_state: r.request_state,
    refund_state: r.refund_state,
    reconciliation_status: r.reconciliation_status,
    ...(evidenceVisible(r.requested_by, reader) ? { category: r.category } : { evidence_withheld: 'FINANCE_SCOPE_REQUIRED' as const }),
    provider_invoice_ref: r.provider_invoice_ref,
    provider_payment_ref: r.provider_payment_ref,
    provider_refund_ref: r.provider_refund_ref,
    currency: r.currency,
    ...(amounts ? { amount_minor: r.amount_minor } : { amount_withheld: 'FINANCE_SCOPE_REQUIRED' as const }),
    effective_at: iso(r.effective_at),
    accounting_period: r.accounting_period,
    requested_by: r.requested_by,
    created_at: r.created_at.toISOString(),
    applied_at: iso(r.applied_at),
  };
}

@Controller('platform/commercial/finance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialRefundReportController {
  constructor(private readonly refunds: CommercialRefundReportService) {}

  @Get('refunds')
  @RequireScopes('platform:billing:read')
  async list(@Query() q: RefundReportQueryDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<RefundReportResponseDto> {
    if (auth.consumer_type !== 'platform') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
        requestId,
        details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
      });
    }
    try {
      const out = await this.refunds.list(q);
      const reader = financeReader(auth);
      return { refunds: out.refunds.map((r) => refundReportRowDto(r, reader)), next_cursor: out.next_cursor };
    } catch (err) {
      if (err instanceof RefundReportQueryError) throw new AramoError('VALIDATION_ERROR', err.message, 400, { requestId, details: { reason: 'invalid_cursor' } });
      throw err;
    }
  }
}
