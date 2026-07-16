import { IsString, Length, Matches } from 'class-validator';
import type { PortalVerificationItem } from '@aramo/talent-trust';

// Portal P3a (Directive §PR-2, rulings 1-2 + Amendment v1.1) — the talent
// verification-view + dispute request/response envelopes. TRUST-CLASS: the
// verification view is the wall's first live member. The request carries ONLY
// the opaque item id (a server-minted surrogate, never a raw PK / PII) + the
// free-text statement. The dispute id is resolved through the caller's cluster
// (uniform 404 out-of-chain), never trusted from the body for WHO.

// A statement is free-text, bounded (no structured "reason taxonomy" — ruling 2).
const STATEMENT_MIN = 1;
const STATEMENT_MAX = 4000;

export class PortalDisputeOpenRequestDto {
  // The opaque verification-view item id (lowercase hex HMAC surrogate). Format-
  // validated only; membership/resolution is server-side (uniform 404 if not in
  // the caller's current view).
  @IsString()
  @Matches(/^[0-9a-f]{64}$/, { message: 'item_id must be a 64-char hex digest' })
  item_id!: string;

  @IsString()
  @Length(STATEMENT_MIN, STATEMENT_MAX)
  statement!: string;
}

export class PortalDisputeRespondRequestDto {
  @IsString()
  @Length(STATEMENT_MIN, STATEMENT_MAX)
  statement!: string;
}

// ── Response envelopes (openapi/portal.yaml; the trust-class members) ──

// The talent verification view (ruling 1). Each item is kind + status + dates
// + the opaque id — re-projected, no verifier/tenant/number/PII.
export interface PortalVerificationsResponseDto {
  verifications: PortalVerificationItem[];
}

// A talent-facing dispute row. NO SLA clocks (internal, P3b report), NO item
// digest, NO tenant/subject/work-item identifiers.
export interface PortalDisputeMutationDto {
  dispute_id: string;
  status: string; // OPEN | UNDER_REVIEW | RESOLVED_CORRECTED | RESOLVED_UPHELD | WITHDRAWN
  opened_at: string;
}

export interface PortalDisputeStatementDto {
  statement: string;
  created_at: string;
}

export interface PortalDisputeDetailDto {
  dispute_id: string;
  status: string;
  opened_at: string;
  resolution_note: string | null;
  statements: PortalDisputeStatementDto[];
}

export interface PortalDisputeListResponseDto {
  disputes: PortalDisputeMutationDto[];
}
