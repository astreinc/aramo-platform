// CI-B5Z — provider-neutral extraction of the Zoom Phone
// `phone.recording_transcript_completed` webhook payload. Zoom-specific field
// names are read HERE and never propagated: the extracted shape carries only
// neutral identifiers. The ephemeral `download_url` is captured for logging-free
// awareness but is NEVER persisted or used (the client downloads via the FIXED
// official endpoint keyed by recording_id — see zoom-transcript-http.client.ts).

/** Neutral view of a recording-transcript-completed event (no Zoom vocabulary downstream). */
export interface ZoomRecordingTranscriptEventView {
  /** Stable Zoom recording id — the retrieval endpoint key + acquisition ref. */
  readonly recording_id: string;
  /** Stable transcript id where Zoom supplies one; else falls back to recording_id. */
  readonly provider_transcript_id: string;
  /** Correlation identifiers back to a CommunicationInteraction (any that exist). */
  readonly call_id?: string;
  readonly call_history_id?: string;
  readonly call_element_id?: string;
  /** Ephemeral — NEVER persisted/logged; the fixed endpoint is used instead. */
  readonly ephemeral_download_url?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Parse the Zoom event payload. Returns null when it is not a well-formed
 * recording-transcript-completed payload (caller treats null as unsupported).
 * Accepts the documented `{ payload: { object: {...} } }` envelope shape.
 */
export function parseZoomRecordingTranscriptEvent(
  event: unknown,
): ZoomRecordingTranscriptEventView | null {
  const root = (event ?? {}) as { payload?: { object?: Record<string, unknown> }; object?: Record<string, unknown> };
  const obj = root.payload?.object ?? root.object;
  if (obj === undefined || obj === null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  // Zoom has used both `recording_id` and `id` for the recording resource.
  const recordingId = str(o['recording_id']) ?? str(o['id']);
  if (recordingId === undefined) return null;
  const transcriptId = str(o['transcript_id']) ?? recordingId;
  return {
    recording_id: recordingId,
    provider_transcript_id: transcriptId,
    call_id: str(o['call_id']),
    call_history_id: str(o['call_history_id']) ?? str(o['call_log_id']),
    call_element_id: str(o['call_element_id']),
    ephemeral_download_url: str(o['download_url']),
  };
}
