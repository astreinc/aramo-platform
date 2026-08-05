import { IsIn, IsUUID } from 'class-validator';
import { PLACEMENT_STATES } from '@aramo/placement';

// Track 3 / E1-b — HTTP request DTOs for the PlacementProcess surface. tenant_id
// is server-derived from the JWT, never the body.

export class CreatePlacementDto {
  @IsUUID()
  submittal_id!: string;

  @IsUUID()
  requisition_id!: string;

  @IsUUID()
  talent_record_id!: string;
}

// One generic transition route (E1-b §1): the target state is in the body and the
// canonical 14-edge matrix enforces legality. `to` must be a known placement
// state; an illegal EDGE is a domain refusal (PLACEMENT_STATE_INVALID, 422).
export class TransitionPlacementDto {
  @IsIn(PLACEMENT_STATES as readonly string[])
  to!: string;
}
