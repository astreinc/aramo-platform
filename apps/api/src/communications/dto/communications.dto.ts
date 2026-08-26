import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type {
  CommunicationChannel,
  CommunicationDirection,
  CommunicationInteractionStatus,
  CommunicationProviderIdentityStatus,
} from '@aramo/communications';

const PROVIDER_IDENTITY_STATUSES = ['active', 'unmapped', 'disabled', 'reauth_required'] as const;

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
