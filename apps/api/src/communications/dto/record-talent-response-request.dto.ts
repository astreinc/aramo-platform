import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { CommunicationChannel } from '@aramo/communications';

// Recruiting-Journey §7/§15/§16 — the canonical "Record Talent response" request.
// The recruiter attests that the Talent responded via a channel, at a time, for a
// bound Pipeline. The FE's four tiles (Phone / Email / SMS / Other) map 1:1 to these
// channel values (phone = voice). `meeting` is NOT an attested-response channel.
export const TALENT_RESPONSE_CHANNELS = ['voice', 'email', 'sms', 'other'] as const;
export type TalentResponseChannel = (typeof TALENT_RESPONSE_CHANNELS)[number];

export class RecordTalentResponseDto {
  // The bound Pipeline episode whose milestone this response grounds. Talent +
  // Requisition are resolved server-side FROM the pipeline (never trusted from the
  // body) so evidence is always bound to the correct context (§18).
  @IsUUID() pipeline_id!: string;

  // Response channel (phone = voice). Note is REQUIRED when channel='other'
  // (enforced in the service, where the cross-field rule lives).
  @IsIn(TALENT_RESPONSE_CHANNELS) channel!: TalentResponseChannel & CommunicationChannel;

  // WHEN the Talent responded. Must not be in the future and must not precede the
  // first grounded outbound contact for this Talent × Requisition (service-enforced).
  @IsISO8601() occurred_at!: string;

  // Optional recruiter note (required when channel='other'). 500-char cap (§6).
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}
