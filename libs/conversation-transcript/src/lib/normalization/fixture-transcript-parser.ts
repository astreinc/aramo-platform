// CI-B4 — the generic, provider-neutral fixture source parser. This is the ONLY
// parser B4 ships: it decodes a well-defined Aramo-canonical INPUT format so the
// normalization contract can be proven end-to-end WITHOUT any real provider
// adapter (those arrive in the CI-B5 seams). It carries NO vendor vocabulary and
// hard-codes no provider business logic. Malformed input throws (mapped to
// SOURCE_PARSE_FAILED by the service) — it never fabricates content.

import { TranscriptSpeakerRole, TRANSCRIPT_SPEAKER_ROLES } from '../domain/transcript-enums.js';

import type {
  ParsedSourceTranscript,
  RawTranscriptSegment,
  TranscriptSourceParser,
} from './transcript-source-parser.port.js';

/** The declared format token this parser handles (provider-neutral). */
export const FIXTURE_TRANSCRIPT_FORMAT = 'aramo.transcript.fixture.v1';

const SPEAKER_ROLES = new Set<string>(TRANSCRIPT_SPEAKER_ROLES);

interface FixtureSegment {
  provider_segment_id?: unknown;
  provider_speaker_id?: unknown;
  speaker_label?: unknown;
  speaker_role_hint?: unknown;
  start_ms?: unknown;
  end_ms?: unknown;
  text?: unknown;
}

function optString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error('bad string field');
  return v;
}

function optNumber(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('bad number field');
  return v;
}

export class FixtureTranscriptParser implements TranscriptSourceParser {
  formatKey(): string {
    return FIXTURE_TRANSCRIPT_FORMAT;
  }

  parse(bytes: Buffer): ParsedSourceTranscript {
    let doc: { language?: unknown; segments?: unknown };
    try {
      doc = JSON.parse(bytes.toString('utf8')) as typeof doc;
    } catch {
      // Never surface raw content in the error (directive §logging).
      throw new Error('fixture transcript is not valid JSON');
    }
    if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.segments)) {
      throw new Error('fixture transcript missing segments array');
    }
    const language = optString(doc.language);
    const segments: RawTranscriptSegment[] = doc.segments.map((raw, i) => {
      const s = raw as FixtureSegment;
      if (typeof s.text !== 'string') {
        throw new Error(`fixture segment ${i} missing text`);
      }
      let roleHint: TranscriptSpeakerRole | undefined;
      if (s.speaker_role_hint !== undefined && s.speaker_role_hint !== null) {
        const hint = String(s.speaker_role_hint);
        // Only accept a hint that is already a canonical role; otherwise ignore
        // it (the normalizer will record UNKNOWN — no inference).
        if (SPEAKER_ROLES.has(hint)) roleHint = hint as TranscriptSpeakerRole;
      }
      return {
        provider_segment_id: optString(s.provider_segment_id),
        provider_speaker_id: optString(s.provider_speaker_id),
        speaker_label: optString(s.speaker_label),
        speaker_role_hint: roleHint,
        start_ms: optNumber(s.start_ms),
        end_ms: optNumber(s.end_ms),
        text: s.text,
      };
    });
    return { language, segments };
  }
}
