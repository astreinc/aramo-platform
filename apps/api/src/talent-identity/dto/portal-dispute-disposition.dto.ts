import { IsString, Length } from 'class-validator';
import { LIFECYCLE_TEXT_MAX } from '@aramo/intelligence-contracts';

import type { IntelligenceStatus } from '../intelligence-access.js';

// Portal P3b → ATI-SEP-1 T10 WP3b — the TENANT-side dispute-disposition
// request/response envelopes (relayed to Talent Intelligence). Tenant-facing
// (the reviewer's own worklist): the record ids are the tenant's own references
// — this is NOT a trust-class talent surface. `identity:resolve`-gated.

export class PortalDisputeDisposeDto {
  // The resolution note recorded on the dispute in TI.
  @IsString()
  @Length(1, LIFECYCLE_TEXT_MAX)
  note!: string;
}

export class PortalDisputeRequestInfoDto {
  @IsString()
  @Length(1, LIFECYCLE_TEXT_MAX)
  note!: string;
}

// A tenant worklist entry (one per dispute).
export interface PortalDisputeTenantItemDto {
  dispute_id: string;
  /** The tenant's own ATS records on the disputed subject. */
  talent_record_ids: string[];
  assertion_id: string;
  /** The disputed assertion's type (e.g. VERIFICATION_OUTCOME, TITLE). */
  item_type: string;
  contributed_by: string; // REQUESTING_TENANT | OTHER_SOURCE | TALENT_INTELLIGENCE
  status: string; // OPEN | UNDER_REVIEW | RESOLVED_CORRECTED | RESOLVED_UPHELD | WITHDRAWN | RESOLVED_NO_TRANSITION
  arrived_at: string;
  updated_at: string;
  triage_due_at: string;
  reinvestigation_due_at: string;
}

export interface PortalDisputeTenantListDto {
  intelligence_status: IntelligenceStatus;
  disputes: PortalDisputeTenantItemDto[];
  next_cursor: string | null;
}

export interface PortalDisputeTenantStatementDto {
  author: string; // TALENT | TENANT
  statement: string;
  created_at: string;
}

export interface PortalDisputeTenantDetailDto extends PortalDisputeTenantItemDto {
  opened_at: string;
  assertion_status: string;
  assertion_payload: Record<string, unknown>;
  resolution_note: string | null;
  no_transition_reason: string | null;
  reinvestigation_extended_at: string | null;
  statements: PortalDisputeTenantStatementDto[];
}

// The disposition action envelope (triage / request-info / correct / uphold / extend).
export interface PortalDisputeDispositionResultDto {
  dispute_id: string;
  status: string;
}
