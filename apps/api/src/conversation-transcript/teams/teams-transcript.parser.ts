import type {
  ParsedSourceTranscript,
  RawTranscriptSegment,
  TranscriptSourceParser,
} from '@aramo/conversation-transcript';

import { MICROSOFT_TEAMS_TRANSCRIPT_FORMAT } from './teams-transcript.constants.js';

// TIP-E2E INC-3 A1-5 — B4 parser for Teams transcript content. Speaker-attributed
// content is WEBVTT with `<v Name>` voice tags (closed by `</v>`). The
// unattributed fallback has timestamped utterances without speaker information;
// its exact line layout is not specified by Microsoft, so it is parsed
// conservatively: WEBVTT cue blocks when present, else "start --> end" timed
// lines, else each non-empty line is one untimed utterance. A parser never
// invents speaker or timing data (B4 rule): absent → undefined.
const CUE_TIMING_RE =
  /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{3})\s+-->\s+(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{3})/;
const VOICE_TAG_RE = /^<v(?:\.[^ >]+)*\s+([^>]+)>(.*?)(?:<\/v>)?$/s;

function toMs(h: string | undefined, m: string, s: string, ms: string): number {
  return (Number(h ?? '0') * 3600 + Number(m) * 60 + Number(s)) * 1000 + Number(ms);
}

function cleanText(t: string): string {
  return t.replace(/<\/?[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

export class TeamsTranscriptParser implements TranscriptSourceParser {
  formatKey(): string {
    return MICROSOFT_TEAMS_TRANSCRIPT_FORMAT;
  }

  parse(bytes: Buffer): ParsedSourceTranscript {
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const segments = /^WEBVTT(?:\s|$)/.test(text) ? this.parseVtt(text) : this.parsePlain(text);
    if (segments.length === 0) throw new Error('Teams transcript contained no utterances');
    return { segments };
  }

  private parseVtt(text: string): RawTranscriptSegment[] {
    const out: RawTranscriptSegment[] = [];
    for (const block of text.split(/\n{2,}/).map((b) => b.trim()).filter((b) => b.length > 0)) {
      if (/^WEBVTT/.test(block) || /^NOTE(?:\s|$)/.test(block)) continue;
      const lines = block.split('\n');
      let idx = 0;
      let cueId: string | undefined;
      if (!CUE_TIMING_RE.test(lines[0] ?? '')) {
        cueId = (lines[0] ?? '').trim() || undefined;
        idx = 1;
      }
      const timing = CUE_TIMING_RE.exec(lines[idx] ?? '');
      if (timing === null) continue;
      const raw = lines.slice(idx + 1).join('\n').trim();
      let speaker: string | undefined;
      let body = raw;
      const voice = VOICE_TAG_RE.exec(raw);
      if (voice !== null) {
        speaker = voice[1]?.trim() || undefined;
        body = voice[2] ?? '';
      }
      const clean = cleanText(body);
      if (clean.length === 0) continue;
      out.push({
        provider_segment_id: cueId,
        speaker_label: speaker,
        start_ms: toMs(timing[1], timing[2] as string, timing[3] as string, timing[4] as string),
        end_ms: toMs(timing[5], timing[6] as string, timing[7] as string, timing[8] as string),
        text: clean,
      });
    }
    return out;
  }

  private parsePlain(text: string): RawTranscriptSegment[] {
    const out: RawTranscriptSegment[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] ?? '').trim();
      if (line.length === 0) continue;
      const timing = CUE_TIMING_RE.exec(line);
      if (timing !== null) {
        const rest = line.slice(timing[0].length).trim();
        const body = rest.length > 0 ? rest : (lines[i + 1] ?? '').trim();
        if (rest.length === 0) i++;
        const clean = cleanText(body);
        if (clean.length === 0) continue;
        out.push({
          start_ms: toMs(timing[1], timing[2] as string, timing[3] as string, timing[4] as string),
          end_ms: toMs(timing[5], timing[6] as string, timing[7] as string, timing[8] as string),
          text: clean,
        });
        continue;
      }
      const clean = cleanText(line);
      if (clean.length > 0) out.push({ text: clean });
    }
    return out;
  }
}
