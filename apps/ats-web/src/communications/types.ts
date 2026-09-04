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

// COMM-C2A — the recorded call interaction (compact FE mirror; no secrets).
export interface CommunicationInteractionView {
  readonly id: string;
  readonly channel: string;
  readonly direction: string;
  readonly status: string;
  readonly from_address: string;
  readonly to_address: string;
  readonly created_at: string;
}

// COMM-C2A — the append-only disposition vocabulary (the 10 delivered outcomes).
// Reused verbatim from the backend taxonomy — no second outcome set (R11).
export const COMMUNICATION_DISPOSITION_OUTCOMES = [
  'connected',
  'interested',
  'callback_requested',
  'follow_up_required',
  'left_voicemail',
  'no_answer',
  'busy',
  'wrong_number',
  'not_interested',
  'do_not_contact',
] as const;
export type CommunicationDispositionOutcome =
  (typeof COMMUNICATION_DISPOSITION_OUTCOMES)[number];

// COMM-C2A — provider-neutral derived voice evidence for a Talent × Requisition
// (mirror of VoiceEngagementEvidenceDto). Lane-2 facts only — no vendor key.
export type VoiceEvidenceStrength = 'PROVIDER_VERIFIED' | 'RECRUITER_ATTESTED';

export interface VoiceEngagementEvidence {
  readonly talent_id: string;
  readonly requisition_id: string;
  readonly attempted: boolean;
  readonly two_way_conversation: boolean;
  readonly evidence_strength: VoiceEvidenceStrength | null;
  readonly latest_interaction_id: string | null;
  readonly latest_outcome: string | null;
  readonly latest_at: string | null;
}

/** COMM-C2A — the Talent × Requisition (+ pipeline) context for a recruiting call. */
export interface CallRegardingContext {
  readonly requisition_id: string;
  readonly pipeline_id: string;
}
