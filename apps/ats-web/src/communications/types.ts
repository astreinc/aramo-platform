// COMM-B4 — FE mirror of the communications read contracts (openapi/ats.yaml
// CommunicationCapabilities + CommunicationProviderIdentity). Hand-mirrored (R2:
// apps/ats-web must not import @aramo/communications — a forbidden domain edge);
// a BE shape change surfaces as a failing build here, not silent runtime drift.
// No secret material is ever part of these shapes.

export interface CommunicationVoiceCapability {
  readonly outbound: boolean;
  readonly inbound: boolean;
  readonly embedded: boolean;
}

export interface CommunicationCapabilities {
  readonly provider_key: string;
  readonly capabilities: {
    readonly voice: CommunicationVoiceCapability;
    readonly sms?: { readonly outbound: boolean; readonly inbound: boolean };
    readonly recording?: boolean;
    readonly transcript?: boolean;
  };
}

export type CommunicationProviderIdentityStatus =
  | 'active'
  | 'unmapped'
  | 'disabled'
  | 'reauth_required';

export interface CommunicationProviderIdentity {
  readonly recruiter_id: string;
  readonly provider_user_id: string;
  readonly provider_extension_id: string | null;
  readonly display_phone_number: string | null;
  readonly extension: string | null;
  readonly voice_enabled: boolean;
  readonly sms_enabled: boolean;
  readonly status: CommunicationProviderIdentityStatus;
}

/** COMM-V1 operational scope gating the recruiter Call affordance (least-visibility). */
export const COMMUNICATION_VOICE_CALL_SCOPE = 'communication:voice:call';
