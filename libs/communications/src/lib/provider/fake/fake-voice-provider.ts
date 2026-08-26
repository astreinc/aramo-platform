import type {
  IntegrationConnectionView,
  NormalizedVoiceEvent,
  ProviderCallReference,
  ProviderHealth,
  NormalizedVoiceState,
  VoiceCallLaunch,
  VoiceCallRequest,
  VoiceCapabilities,
  VoiceProvider,
} from '../voice-provider.port.js';
import type { CommunicationInteractionStatus } from '../../domain/communication-enums.js';

// COMM-V1 — deterministic in-memory voice provider for CI / Playwright / local
// dev (directive §50). No network, no real provider, no provider vocabulary
// leaking into the domain. Capabilities match core Voice V1 (outbound voice).
//
// The fake models a generic provider event: the test supplies an already-mapped
// canonical target_status, so normalization is proven WITHOUT any Zoom coupling.

export interface FakeProviderEvent {
  readonly provider_event_key: string;
  readonly event_type: string;
  readonly target_status: CommunicationInteractionStatus;
  readonly provider_call_id?: string;
  readonly provider_call_history_uuid?: string;
  readonly provider_call_element_id?: string;
}

export const FAKE_VOICE_PROVIDER_KEY = 'fake_voice';

export class FakeVoiceProvider implements VoiceProvider {
  private launchCounter = 0;

  providerKey(): string {
    return FAKE_VOICE_PROVIDER_KEY;
  }

  getCapabilities(): VoiceCapabilities {
    return {
      voice: { outbound: true, inbound: false, embedded: true },
    };
  }

  async validateConnection(connection: IntegrationConnectionView): Promise<ProviderHealth> {
    return { healthy: connection.provider_account_id !== null };
  }

  async initiateCall(input: VoiceCallRequest): Promise<VoiceCallLaunch> {
    void input; // deterministic fake — the request shape is validated by the type only
    this.launchCounter += 1;
    return {
      launch_mode: 'fake_embed',
      provider_interaction_id: `fake-intx-${this.launchCounter}`,
      provider_call_id: `fake-call-${this.launchCounter}`,
    };
  }

  async normalizeWebhook(event: unknown): Promise<NormalizedVoiceEvent> {
    const e = event as FakeProviderEvent;
    return {
      provider_event_key: e.provider_event_key,
      event_type: e.event_type,
      target_status: e.target_status,
      provider_call_id: e.provider_call_id,
      provider_call_history_uuid: e.provider_call_history_uuid,
      provider_call_element_id: e.provider_call_element_id,
    };
  }

  async reconcileInteraction(reference: ProviderCallReference): Promise<NormalizedVoiceState> {
    // The fake reports a completed reconciliation for any known reference.
    void reference;
    return { target_status: 'completed', duration_seconds: 0 };
  }
}
