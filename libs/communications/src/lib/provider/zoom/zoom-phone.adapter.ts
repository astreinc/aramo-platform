import type {
  IntegrationConnectionView,
  NormalizedVoiceEvent,
  ProviderHealth,
  VoiceCallLaunch,
  VoiceCallRequest,
  VoiceCapabilities,
  VoiceProvider,
} from '../voice-provider.port.js';

// COMM-B3 — Zoom Phone provider adapter. Vendor code lives under provider/zoom/,
// confined behind the communications-owned VoiceProvider port (R-COMM-PROVIDER-PORT)
// and OUTSIDE the provider-neutrality scan, so Zoom terminology is legal here.
//
// B3 scope = the CONNECTION BINDING seam: providerKey + static capability
// descriptor + a connection health proxy. Live Zoom API behaviour (call
// initiation = B5, webhook normalization = B6, real token refresh + a real
// account/health ping = B8) is DEFERRED and MUST NOT be invented from
// assumptions (real Zoom is NOT-VERIFIED in CI — no live credentials).

/** The locked provider key string (directive R-COMM-CONNECTION). */
export const ZOOM_PHONE_PROVIDER_KEY = 'zoom_phone';

/** Raised when a not-yet-implemented (deferred) adapter operation is invoked. */
export class ZoomAdapterDeferredError extends Error {
  constructor(operation: string, slice: string) {
    super(`ZoomPhoneAdapter.${operation} is deferred to COMM-${slice}`);
    this.name = 'ZoomAdapterDeferredError';
  }
}

export class ZoomPhoneAdapter implements VoiceProvider {
  providerKey(): string {
    return ZOOM_PHONE_PROVIDER_KEY;
  }

  /**
   * STATIC capability descriptor for Zoom Phone (directive §15). This is
   * configuration, not a live API call, so it is safe in CI. Outbound voice is
   * the COMM-V1 target; sms/recording/transcript are declared for provider
   * neutrality but gated by scope/later slices before any execution.
   */
  getCapabilities(): VoiceCapabilities {
    return {
      voice: { outbound: true, inbound: true, embedded: true },
      sms: { outbound: true, inbound: true },
      recording: true,
      transcript: true,
    };
  }

  /**
   * Connection health PROXY (B3): a bound connection is healthy iff it carries a
   * provider account identity. A real Zoom account/token ping is deferred to B8
   * (live lane) — do not fabricate one here.
   */
  async validateConnection(connection: IntegrationConnectionView): Promise<ProviderHealth> {
    if (connection.provider_account_id === null) {
      return { healthy: false, detail: 'no provider_account_id bound to the connection' };
    }
    return { healthy: true };
  }

  async initiateCall(_input: VoiceCallRequest): Promise<VoiceCallLaunch> {
    void _input;
    throw new ZoomAdapterDeferredError('initiateCall', 'B5');
  }

  async normalizeWebhook(_event: unknown): Promise<NormalizedVoiceEvent> {
    void _event;
    throw new ZoomAdapterDeferredError('normalizeWebhook', 'B6');
  }
}
