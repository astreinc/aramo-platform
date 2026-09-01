import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

// POST /v1/offers — create a DRAFT offer from a submittal.
export class CreateOfferDto {
  @IsUUID() submittal_id!: string;
  @IsUUID() requisition_id!: string;
  @IsUUID() talent_record_id!: string;
  @IsOptional() @IsString() proposed_start_date?: string | null;
  @IsOptional() @IsString() offer_expires_at?: string | null;
  @IsOptional() @IsString() @MaxLength(200) client_offer_reference?: string | null;
  // L4-A / P1 — offer_terms_summary is SUPPLEMENTAL narrative only; the structured
  // compensation snapshot below carries the Talent-facing pay/salary terms. The
  // (type, amount, currency, period) tuple is all-or-nothing and semantically
  // validated in the repository (classifyOfferCompensation → VALIDATION_ERROR);
  // the DTO layer only shape-checks. NO bill rate / margin fields — by design.
  @IsOptional() @IsString() @MaxLength(2000) offer_terms_summary?: string | null;
  @IsOptional() @IsString() compensation_type?: string | null;
  @IsOptional() @IsString() compensation_amount?: string | null;
  @IsOptional() @IsString() compensation_currency?: string | null;
  @IsOptional() @IsString() compensation_period?: string | null;
}

// PATCH /v1/offers/:id — a governed transition. `to_state` is the target; the
// (from,to) edge determines the action and legality (DB trigger + ADR-0024).
const OFFER_TARGET_STATES = ['SENT', 'NEGOTIATION', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'RESCINDED', 'DRAFT'] as const;

export class TransitionOfferDto {
  @IsIn(OFFER_TARGET_STATES) to_state!: (typeof OFFER_TARGET_STATES)[number];
  @IsOptional() @IsString() proposed_start_date?: string | null;
  @IsOptional() @IsString() offer_expires_at?: string | null;
  @IsOptional() @IsString() @MaxLength(200) client_offer_reference?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) offer_terms_summary?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) decline_reason?: string | null;
}
