import { IsString, Length } from 'class-validator';

// Portal P3b (§PR-2 + Amendment v1.2) — the TENANT-side dispute-disposition
// request/response envelopes. Tenant-facing (the reviewer's own worklist): the
// tenant + subject identifiers are the tenant's own data, not origin-secret —
// this is NOT a trust-class talent surface. `identity:resolve`-gated.

const NOTE_MIN = 1;
const NOTE_MAX = 4000;

export class PortalDisputeDisposeDto {
  // The resolution note recorded on the dispute + passed as the TR-15 justification.
  @IsString()
  @Length(NOTE_MIN, NOTE_MAX)
  note!: string;
}

export class PortalDisputeRequestInfoDto {
  @IsString()
  @Length(NOTE_MIN, NOTE_MAX)
  note!: string;
}

// A tenant worklist entry (one per work item the tenant holds).
export interface PortalDisputeTenantItemDto {
  dispute_id: string;
  subject_id: string;
  item_type: string; // ANCHOR | VERIFICATION
  status: string; // work-item status
  arrived_at: string;
}

export interface PortalDisputeTenantListDto {
  disputes: PortalDisputeTenantItemDto[];
}

export interface PortalDisputeTenantStatementDto {
  author: string; // TALENT | TENANT
  statement: string;
  created_at: string;
}

export interface PortalDisputeTenantWorkItemDto {
  subject_id: string;
  status: string;
  no_transition_reason: string | null;
}

export interface PortalDisputeTenantDetailDto {
  dispute_id: string;
  item_type: string;
  status: string; // parent status
  opened_at: string;
  resolution_note: string | null;
  triage_due_at: string;
  reinvestigation_due_at: string;
  statements: PortalDisputeTenantStatementDto[];
  work_items: PortalDisputeTenantWorkItemDto[];
}

// The disposition action envelope (returned by triage/correct/uphold/withdraw/extend).
export interface PortalDisputeDispositionResultDto {
  dispute_id: string;
  status: string;
}
