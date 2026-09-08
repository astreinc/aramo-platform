// CI-B4 — the provider-neutral source-decoding seam (directive §source-format-
// handling). A parser converts opaque source bytes of a DECLARED format into a
// provider-neutral intermediate (`RawTranscriptSegment[]`). Provider-specific
// field names terminate HERE — nothing downstream of the parser sees a vendor
// shape. B4 ships only a generic fixture parser (no real provider adapter —
// those arrive in the CI-B5 seams).

import type { TranscriptSpeakerRole } from '../domain/transcript-enums.js';

/**
 * Provider-neutral parsed segment — the ONLY shape the normalizer consumes from
 * a parser. A parser preserves what the source supplied and invents nothing:
 * absent speaker/timestamps stay absent (directive §12-18 — no fabrication).
 */
export interface RawTranscriptSegment {
  /** Stable provider segment id, where the source supplies one. */
  readonly provider_segment_id?: string;
  /** Provider speaker id, where supplied (e.g. "1"). */
  readonly provider_speaker_id?: string;
  /** Provider speaker display label, where supplied. */
  readonly speaker_label?: string;
  /**
   * A role hint ONLY when the source itself carries a RELIABLE role mapping.
   * A bare display name ("Speaker 1") is NOT a reliable mapping and must be left
   * undefined → the normalizer records UNKNOWN (directive §speaker-role).
   */
  readonly speaker_role_hint?: TranscriptSpeakerRole;
  /** Milliseconds from start, where supplied. */
  readonly start_ms?: number;
  /** Milliseconds from start, where supplied. */
  readonly end_ms?: number;
  /** Raw utterance text (structural normalization happens in the normalizer). */
  readonly text: string;
}

/** Result of parsing a source artifact. */
export interface ParsedSourceTranscript {
  /** Provider-declared language, where supplied (never detected in B4). */
  readonly language?: string;
  /** Segments in provider sequence order (never re-sorted by the parser). */
  readonly segments: readonly RawTranscriptSegment[];
}

/**
 * A source parser for one declared format. Implementations MUST be deterministic
 * and MUST throw on malformed input (mapped to SOURCE_PARSE_FAILED by the
 * service) rather than fabricating content.
 */
export interface TranscriptSourceParser {
  /** The declared source-format token this parser handles (provider-neutral). */
  formatKey(): string;
  /** Parse opaque source bytes into the provider-neutral intermediate. */
  parse(bytes: Buffer): ParsedSourceTranscript;
}

/** DI token for the parser registry (bound at the composition root). */
export const TRANSCRIPT_SOURCE_PARSER_REGISTRY = 'TRANSCRIPT_SOURCE_PARSER_REGISTRY';
