import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { PRODUCT_KEYS, type ProductKey } from '@aramo/subscription';

// CCP-C4-P — GET /platform/commercial/finance/refunds (platform:billing:read): the read-only refund
// report. The amount is returned only with platform:billing:amount:read (else amount_withheld).

export class RefundReportQueryDto {
  @IsOptional() @IsUUID() tenant_id?: string;
  @IsOptional() @IsIn([...PRODUCT_KEYS]) product_key?: ProductKey;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(2000) cursor?: string;
}

export interface RefundReportRowDto {
  change_request_id: string;
  tenant_id: string;
  product_key: string;
  request_state: string;
  // requested | approved | pending | confirmed | failed | reconciled | closed
  refund_state: string;
  // NOT_SENT | PENDING_PROVIDER | COMMAND_FAILED | CONFIRMED | RESOLVED_NOT_EXECUTED
  reconciliation_status: string;
  category: string | null;
  provider_invoice_ref: string | null;
  provider_payment_ref: string | null;
  provider_refund_ref: string | null;
  currency: string | null;
  amount_minor?: number | null;
  amount_withheld?: 'FINANCE_SCOPE_REQUIRED';
  effective_at: string | null;
  accounting_period: string | null;
  requested_by: string;
  created_at: string;
  applied_at: string | null;
}

export interface RefundReportResponseDto {
  refunds: RefundReportRowDto[];
  next_cursor: string | null;
}
