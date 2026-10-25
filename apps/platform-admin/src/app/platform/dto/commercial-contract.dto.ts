import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

// CCP-B4 — GET /platform/commercial/contracts and /contracts/{id} (platform:subscription:read).
// The contract carries negotiated terms and hashed evidence only; its status, plan, version and
// commitment are read THROUGH the governed TenantSubscription (MP-A2 N-3(c), (d)).

export class ListCommercialContractsQueryDto {
  @IsOptional() @IsUUID() tenant_id?: string;
  @IsOptional() @IsIn(['ACTIVE', 'ENDED']) status?: 'ACTIVE' | 'ENDED';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export interface CommercialContractPersonDto {
  user_id: string;
  display_name: string | null;
  email: string | null;
}

export interface CommercialContractDocumentDto {
  name: string;
  sha256: string;
  byte_size: number | null;
  media_type: string | null;
  recorded_by: CommercialContractPersonDto;
  recorded_at: string;
  amendment_sequence: number | null;
}

export interface CommercialContractAmendmentDto {
  sequence: number;
  kind: 'AMENDMENT' | 'END';
  summary: string;
  terms: string[] | null;
  document_count: number;
  evidence_ref: string | null;
  change_request_id: string;
  recorded_by: CommercialContractPersonDto;
  recorded_at: string;
}

export interface CommercialContractSummaryDto {
  id: string;
  contract_ref: string;
  tenant: { id: string; name: string; slug: string | null };
  product_key: string;
  /** Derived from the governed subscription row (never stored). */
  status: 'ACTIVE' | 'ENDED';
  subscription: {
    id: string;
    source: string;
    status: string;
    ended_at: string | null;
    commitment_start: string | null;
    commitment_end: string | null;
    plan: { key: string; name: string };
    plan_version: { id: string; version_number: number; status: string };
  };
  provenance: 'CHANGE_REQUEST' | 'MIGRATION';
  recorded_at: string;
}

export interface CommercialContractDetailDto extends CommercialContractSummaryDto {
  terms: string[];
  recorded_terms: string[];
  evidence_ref: string | null;
  recorded_by: CommercialContractPersonDto;
  recorded_by_change_request_id: string;
  documents: CommercialContractDocumentDto[];
  amendments: CommercialContractAmendmentDto[];
  invoicing: { enabled: false; reason: 'enterprise_invoicing_choice_pending' };
}

export interface CommercialContractListResponseDto {
  contracts: CommercialContractSummaryDto[];
}
