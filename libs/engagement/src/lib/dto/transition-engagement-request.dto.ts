import { IsIn, IsUUID } from 'class-validator';

import {
  ENGAGEMENT_STATE_VALUES,
  type EngagementStateValue,
} from '../engagement-state.js';

// M5 PR-4 §4.2 — HTTP request DTO for POST /v1/engagements/{id}/transitions.
//
// Body shape per directive §4.2 + Ruling 10:
//   - to_state: required EngagementStateValue (closed-list validated via
//     @IsIn(ENGAGEMENT_STATE_VALUES)). Illegal-transition refusal
//     (ENGAGEMENT_STATE_INVALID 422) is enforced at the repository layer
//     via canTransition; class-validator only enforces that the value is
//     a member of the 11-state closed list.
//   - event_id: required UUID (server-side generation is also acceptable
//     per directive; explicit request-body field allows the consumer to
//     supply an idempotent event_id for tracing). Note: id of the parent
//     engagement comes from the URL path param.
//
// tenant_id derived from JWT AuthContext (NOT in body).
export class TransitionEngagementRequestDto {
  @IsIn(ENGAGEMENT_STATE_VALUES as unknown as string[])
  to_state!: EngagementStateValue;

  @IsUUID()
  event_id!: string;
}
