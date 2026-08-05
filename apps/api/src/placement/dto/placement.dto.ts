import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PLACEMENT_STATES } from '@aramo/placement';

// Track 3 / E1-b — HTTP request DTOs for the PlacementProcess surface. tenant_id
// is server-derived from the JWT, never the body.

// E1-c (9-c-1) — bounds for the free-text offer-snapshot fields. Non-sensitive
// operational metadata only (NO commercial rates / restricted evidence).
const CLIENT_OFFER_REFERENCE_MAX = 255;
const OFFER_TERMS_SUMMARY_MAX = 2000;

export class CreatePlacementDto {
  @IsUUID()
  submittal_id!: string;

  @IsUUID()
  requisition_id!: string;

  @IsUUID()
  talent_record_id!: string;

  // E1-c offer snapshot (9-c-1). All optional at the wire; offered_at defaults to
  // the server time of the offer fact when omitted. offer_expires_at, when present,
  // must not precede offered_at (enforced in the repository, VALIDATION_ERROR 400).
  @IsOptional()
  @IsDateString()
  offered_at?: string;

  @IsOptional()
  @IsDateString()
  proposed_start_date?: string;

  @IsOptional()
  @IsDateString()
  offer_expires_at?: string;

  @IsOptional()
  @IsString()
  @MaxLength(CLIENT_OFFER_REFERENCE_MAX)
  client_offer_reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(OFFER_TERMS_SUMMARY_MAX)
  offer_terms_summary?: string;
}

// One generic transition route (E1-b §1): the target state is in the body and the
// canonical 14-edge matrix enforces legality. `to` must be a known placement
// state; an illegal EDGE is a domain refusal (PLACEMENT_STATE_INVALID, 422).
export class TransitionPlacementDto {
  @IsIn(PLACEMENT_STATES as readonly string[])
  to!: string;
}
