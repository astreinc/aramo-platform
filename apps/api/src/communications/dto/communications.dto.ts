import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { COMMUNICATION_DISPOSITION_OUTCOMES } from '@aramo/communications';
import type {
  CommunicationChannel,
  CommunicationDirection,
  CommunicationDispositionOutcome,
  CommunicationInteractionStatus,
  CommunicationProviderIdentityStatus,
} from '@aramo/communications';

const PROVIDER_IDENTITY_STATUSES = ['active', 'unmapped', 'disabled', 'reauth_required'] as const;

// COMM-B7 — record a call disposition on an interaction. `disposition` is
// required (one of the 10 locked outcomes); `notes` optional. When `notes` is
// present and non-blank the route additionally requires communication:notes:write
// (enforced in-handler). do_not_contact is a recorded outcome ONLY — it never
// mutates consent / any suppression flag in V1.
export class RecordDispositionDto {
  @IsIn(COMMUNICATION_DISPOSITION_OUTCOMES) disposition!: CommunicationDispositionOutcome;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;
}

// COMM-B5 — call-initiation request body for POST /v1/communications/calls.
// The server resolves the destination from the Talent record's phone_slot; an
// arbitrary client-supplied destination number is NOT accepted (R-COMM-PHONE).
const CALL_PHONE_SLOTS = ['cell', 'work', 'home'] as const;
export type CallPhoneSlot = (typeof CALL_PHONE_SLOTS)[number];

export class InitiateCallRegardingDto {
  @IsUUID() requisition_id!: string;
}

export class InitiateCommunicationCallDto {
  @IsUUID() talent_id!: string;
  @IsIn(CALL_PHONE_SLOTS) phone_slot!: CallPhoneSlot;
  // Optional requisition context; omitted/null for a Talent-only call.
  @IsOptional()
  @ValidateNested()
  @Type(() => InitiateCallRegardingDto)
  regarding?: InitiateCallRegardingDto | null;
}

// COMM-B3 — admin upsert body for PUT /v1/communications/provider-identities/{recruiterId}.
// Authorized by integration:write (part of configuring the tenant's provider
// integration). No secret material is accepted here.
export class UpsertProviderIdentityDto {
  @IsString() @MaxLength(255) provider_user_id!: string;
  @IsOptional() @IsString() @MaxLength(255) provider_extension_id?: string | null;
  @IsOptional() @IsString() @MaxLength(64) display_phone_number?: string | null;
  @IsOptional() @IsString() @MaxLength(32) extension?: string | null;
  @IsOptional() @IsBoolean() voice_enabled?: boolean;
  @IsOptional() @IsBoolean() sms_enabled?: boolean;
  @IsOptional() @IsIn(PROVIDER_IDENTITY_STATUSES) status?: CommunicationProviderIdentityStatus;
}

export interface CommunicationProviderIdentityListDto {
  items: CommunicationProviderIdentityDto[];
}

// COMM-B2 — response DTOs for the Communications/Voice read skeleton. Mirrors of
// the openapi/ats.yaml schemas (documented in Boundary E). No secret/token/raw
// provider payload is ever surfaced; provider call ids are correlation metadata.

export interface VoiceCapabilityDto {
  outbound: boolean;
  inbound: boolean;
  embedded: boolean;
}

export interface CommunicationCapabilitiesDto {
  provider_key: string;
  capabilities: {
    voice: VoiceCapabilityDto;
    sms?: { outbound: boolean; inbound: boolean };
    recording?: boolean;
    transcript?: boolean;
  };
}

export interface CommunicationProviderIdentityDto {
  recruiter_id: string;
  provider_user_id: string;
  provider_extension_id: string | null;
  display_phone_number: string | null;
  extension: string | null;
  voice_enabled: boolean;
  sms_enabled: boolean;
  status: CommunicationProviderIdentityStatus;
}

export interface CommunicationInteractionViewDto {
  id: string;
  channel: CommunicationChannel;
  direction: CommunicationDirection;
  status: CommunicationInteractionStatus;
  integration_connection_id: string;
  from_address: string;
  to_address: string;
  started_at: string | null;
  ringing_at: string | null;
  connected_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  created_at: string;
  updated_at: string;
}

// COMM-B7 — a recorded disposition (append-only history entry).
export interface CommunicationDispositionDto {
  id: string;
  disposition: CommunicationDispositionOutcome;
  notes: string | null;
  dispositioned_at: string;
}

// COMM-B7 — a Talent communication timeline entry: the provider-neutral
// interaction view + its disposition history (dispositioned_at DESC, id DESC).
export interface TalentCommunicationTimelineItemDto extends CommunicationInteractionViewDto {
  dispositions: CommunicationDispositionDto[];
}

export interface TalentCommunicationTimelineResponseDto {
  items: TalentCommunicationTimelineItemDto[];
  next_cursor: string | null;
}
