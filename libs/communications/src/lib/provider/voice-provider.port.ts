// COMM-V1 — the communications-OWNED voice provider port (COMM-B1, R-COMM-PROVIDER-PORT).
// This is NOT the VMS ConnectorAdapter contract — communications owns its own
// calling contract and reuses only the registry PATTERN. No vendor type appears
// in this file; concrete adapters live under provider/<vendor>/ and normalize
// provider events INTO the canonical shapes below.

import type {
  CommunicationChannel,
  CommunicationDirection,
  CommunicationInteractionStatus,
} from '../domain/communication-enums.js';

/** Provider-neutral capability descriptor (directive §15 capabilities model). */
export interface VoiceCapabilities {
  readonly voice: { readonly outbound: boolean; readonly inbound: boolean; readonly embedded: boolean };
  readonly sms?: { readonly outbound: boolean; readonly inbound: boolean };
  readonly recording?: boolean;
  readonly transcript?: boolean;
}

/** A minimal, provider-neutral view of an IntegrationConnection (no secrets). */
export interface IntegrationConnectionView {
  readonly id: string;
  readonly tenant_id: string;
  readonly provider_key: string;
  readonly provider_account_id: string | null;
}

/** Provider health report from validateConnection(). */
export interface ProviderHealth {
  readonly healthy: boolean;
  readonly detail?: string;
}

/**
 * Provider-neutral caller (recruiter) identity. COMM-B5: the service/composition
 * root resolves the recruiter's provider-identity mapping and passes it in HERE —
 * the adapter NEVER reaches back into Communications persistence to discover the
 * mapping (R-COMM-PROVIDER-PORT). Names stay provider-neutral; vendor translation
 * is confined to the concrete adapter.
 */
export interface VoiceCallerIdentity {
  readonly provider_user_id: string;
  readonly provider_extension_id?: string | null;
  readonly extension?: string | null;
}

/** Input to initiate an outbound call (provider-neutral). */
export interface VoiceCallRequest {
  readonly tenant_id: string;
  readonly integration_connection_id: string;
  readonly channel: CommunicationChannel;
  readonly direction: CommunicationDirection;
  readonly from_address: string;
  readonly to_address: string;
  readonly initiated_by_id?: string;
  /** The resolved caller identity (COMM-B5). Adapters must not discover it themselves. */
  readonly caller: VoiceCallerIdentity;
}

/** Result of a launch — a launch mode + optional provider correlation ids. */
export interface VoiceCallLaunch {
  readonly launch_mode: string;
  readonly provider_interaction_id?: string;
  readonly provider_call_id?: string;
}

/**
 * A normalized provider event — the ONLY shape the domain consumes. Provider
 * correlation ids are metadata; the target canonical state is already mapped.
 */
export interface NormalizedVoiceEvent {
  readonly provider_event_key: string;
  readonly event_type: string;
  readonly target_status: CommunicationInteractionStatus;
  readonly provider_call_id?: string;
  readonly provider_call_history_uuid?: string;
  readonly provider_call_element_id?: string;
  readonly occurred_at?: Date;
}

/** Correlation reference used by reconcileInteraction(). */
export interface ProviderCallReference {
  readonly provider_call_id?: string;
  readonly provider_call_history_uuid?: string;
  readonly provider_call_element_id?: string;
}

/** A recovered canonical state from a reconciliation query. */
export interface NormalizedVoiceState {
  readonly target_status: CommunicationInteractionStatus;
  readonly duration_seconds?: number;
}

/**
 * The voice provider contract. A concrete adapter (registered in a later slice)
 * confines all vendor terminology behind this port.
 */
export interface VoiceProvider {
  providerKey(): string;
  getCapabilities(): VoiceCapabilities;
  validateConnection(connection: IntegrationConnectionView): Promise<ProviderHealth>;
  initiateCall(input: VoiceCallRequest): Promise<VoiceCallLaunch>;
  normalizeWebhook(event: unknown): Promise<NormalizedVoiceEvent>;
  reconcileInteraction?(reference: ProviderCallReference): Promise<NormalizedVoiceState>;
}
