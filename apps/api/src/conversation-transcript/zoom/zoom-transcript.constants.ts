// CI-B5Z — Zoom Phone RECORDING-TRANSCRIPT adapter constants (composition root).
//
// Implemented executable path: AD_HOC_RECORDING_TRANSCRIPT. Per the CI-B5Z-0
// discovery ruling, Zoom Phone can transcribe live WITHOUT recording as a
// product, but no supported public API path is proven for Aramo to retrieve
// that native no-recording transcript. THIS implemented path therefore has
// recording_dependency = REQUIRED — a PER-PATH fact, NOT a product-wide Zoom
// invariant (the forbidden global "ZOOM_PHONE_REQUIRES_RECORDING" is never
// asserted; see zoom-transcript-capability.ts).
//
// Provider evidence (official Zoom developer docs, confirmed at B5Z build):
//   * availability event : phone.recording_transcript_completed
//   * retrieval endpoint : GET /v2/phone/recording_transcript/download/{recordingId}
//   * OAuth scope        : phone:read:recording_transcript
//                          (account/server-to-server grants the :admin variant
//                           phone:read:recording_transcript:admin)
//   * transcript format  : WEBVTT (body begins "WEBVTT")
// No production Zoom call is made in B5Z — all HTTP is mocked from these docs.

/** Zoom Phone recording-transcript availability webhook event. */
export const ZOOM_RECORDING_TRANSCRIPT_COMPLETED_EVENT =
  'phone.recording_transcript_completed';

/** Zoom API base (the recording-transcript download endpoint is relative to this). */
export const ZOOM_API_BASE_URL = 'https://api.zoom.us';

/** Zoom API host — the ONLY host the transcript downloader may contact (SSRF allowlist). */
export const ZOOM_API_HOST = 'api.zoom.us';

/** Recording-transcript retrieval path template (recordingId is a stable Zoom id). */
export function zoomRecordingTranscriptPath(recordingId: string): string {
  return `/v2/phone/recording_transcript/download/${encodeURIComponent(recordingId)}`;
}

/** OAuth scope(s) this path requires. Recorded for provenance; not enforced in B5Z. */
export const ZOOM_RECORDING_TRANSCRIPT_SCOPES = [
  'phone:read:recording_transcript',
  'phone:read:recording_transcript:admin',
] as const;

/** The declared source format token the Zoom VTT parser registers under (B4 seam). */
export const ZOOM_RECORDING_TRANSCRIPT_FORMAT = 'zoom.phone.recording_transcript.vtt.v1';

/** Implemented transcript path identifier (evidence/provenance only). */
export const ZOOM_IMPLEMENTED_TRANSCRIPT_PATH = 'AD_HOC_RECORDING_TRANSCRIPT';

/** Bounded-download guards for the transcript body (SSRF + resource safety). */
export const ZOOM_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB ceiling
export const ZOOM_TRANSCRIPT_CONNECT_TIMEOUT_MS = 5_000;
export const ZOOM_TRANSCRIPT_READ_TIMEOUT_MS = 20_000;
export const ZOOM_TRANSCRIPT_MAX_REDIRECTS = 3;

/** Bounded normalization/acquisition retry budget shared with B4 conventions. */
export const ZOOM_TRANSCRIPT_MAX_ACQUISITION_ATTEMPTS = 5;
