// CI-B5Z — the loosely-coupled seam between the existing Zoom webhook ingress
// and the Conversation-Intelligence transcript-acquisition flow. The webhook
// (Communications) depends only on this narrow port + token, never on the
// conversation-transcript composition (dependency points inward). The CI module
// binds the concrete handler. Optional: if unbound, the webhook records the
// event `ignored` and no CI work happens (fail-safe).

export interface ZoomTranscriptEventHandlerInput {
  readonly tenant_id: string;
  readonly integration_connection_id: string;
  /** Trusted (post-HMAC) correlation identifiers from the webhook envelope. */
  readonly correlation: {
    readonly call_id: string | null;
    readonly call_history_uuid: string | null;
    readonly call_element_id: string | null;
  };
  /** The raw (already signature-verified) webhook body string — parsed by the handler. */
  readonly raw_body: string;
}

export interface ZoomTranscriptEventHandler {
  /**
   * Handle a recording-transcript-completed event. Idempotent + restart-safe
   * (durable state lives in the provider-event + ConversationTranscript rows).
   * Returns `retriable: true` when the event should remain re-drivable (e.g.
   * transcript arrived before interaction correlation, or a retryable
   * acquisition failure) so the webhook records it `failed` rather than
   * `processed`.
   */
  handle(input: ZoomTranscriptEventHandlerInput): Promise<{ retriable: boolean }>;
}

export const ZOOM_TRANSCRIPT_EVENT_HANDLER = 'ZOOM_TRANSCRIPT_EVENT_HANDLER';
