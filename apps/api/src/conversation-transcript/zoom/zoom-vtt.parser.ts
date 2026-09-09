// CI-B5Z — Zoom Phone recording-transcript WEBVTT parser. Implements the B4
// provider-neutral TranscriptSourceParser seam: Zoom-specific decoding is
// confined HERE; the OUTPUT (RawTranscriptSegment[]) is provider-neutral and no
// Zoom vocabulary leaks past this boundary. Deterministic; throws on malformed /
// non-transcript input (mapped to SOURCE_PARSE_FAILED). Never fabricates:
// missing speaker/timestamps stay absent, and a voice-tag DISPLAY name is a
// label only (no role inference — the normalizer records UNKNOWN).

import type {
  ParsedSourceTranscript,
  RawTranscriptSegment,
  TranscriptSourceParser,
} from '@aramo/conversation-transcript';

import { ZOOM_RECORDING_TRANSCRIPT_FORMAT } from './zoom-transcript.constants.js';

// HH:MM:SS.mmm or MM:SS.mmm (both legal in WEBVTT).
const CUE_TIMING_RE =
  /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\.(\d{3})\s+-->\s+(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\.(\d{3})/;
// Speaker voice span: <v Display Name>text  (Zoom uses the voice tag for speaker).
const VOICE_TAG_RE = /^<v(?:\.[^ >]+)*\s+([^>]+)>(.*)$/s;

function toMs(h: string | undefined, m: string, s: string, ms: string): number {
  return (Number(h ?? '0') * 3600 + Number(m) * 60 + Number(s)) * 1000 + Number(ms);
}

export class ZoomVttTranscriptParser implements TranscriptSourceParser {
  formatKey(): string {
    return ZOOM_RECORDING_TRANSCRIPT_FORMAT;
  }

  parse(bytes: Buffer): ParsedSourceTranscript {
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    // A Zoom recording transcript is WEBVTT. Reject anything else (e.g. a JSON
    // AI-summary object) — a summary is NOT a transcript (directive: full only).
    if (!/^WEBVTT(?:\s|$)/.test(text)) {
      throw new Error('not a WEBVTT transcript');
    }
    // Blocks are separated by blank lines; the first block is the WEBVTT header.
    const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter((b) => b.length > 0);
    const segments: RawTranscriptSegment[] = [];
    for (const block of blocks) {
      if (/^WEBVTT/.test(block)) continue; // header / NOTE region
      const lines = block.split('\n');
      // Optional cue-id line precedes the timing line.
      let idx = 0;
      let cueId: string | undefined;
      if (!CUE_TIMING_RE.test(lines[0] ?? '')) {
        cueId = (lines[0] ?? '').trim() || undefined;
        idx = 1;
      }
      const timing = CUE_TIMING_RE.exec(lines[idx] ?? '');
      if (timing === null) continue; // not a cue (NOTE/STYLE) — skip
      const startMs = toMs(timing[1], timing[2] as string, timing[3] as string, timing[4] as string);
      const endMs = toMs(timing[5], timing[6] as string, timing[7] as string, timing[8] as string);
      const rawText = lines.slice(idx + 1).join('\n').trim();
      if (rawText.length === 0) continue;
      let speakerLabel: string | undefined;
      let bodyText = rawText;
      const voice = VOICE_TAG_RE.exec(rawText);
      if (voice !== null) {
        speakerLabel = voice[1]?.trim() || undefined;
        bodyText = (voice[2] ?? '').trim();
      }
      // Strip any residual VTT inline tags but preserve wording.
      bodyText = bodyText.replace(/<\/?[^>]+>/g, '').trim();
      if (bodyText.length === 0) continue;
      segments.push({
        provider_segment_id: cueId,
        // provider_speaker_id intentionally absent — Zoom's voice tag is a
        // display label, not a stable speaker id; no role hint (no inference).
        speaker_label: speakerLabel,
        start_ms: startMs,
        end_ms: endMs,
        text: bodyText,
      });
    }
    if (segments.length === 0) {
      throw new Error('WEBVTT contained no transcript cues');
    }
    // Zoom does not carry a BCP-47 language tag in the VTT body — leave absent.
    return { segments };
  }
}
