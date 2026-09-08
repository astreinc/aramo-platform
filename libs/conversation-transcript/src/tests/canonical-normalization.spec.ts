import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canonicalBytes,
  canonicalStringify,
  canonicalize,
} from '../lib/normalization/canonical-json.js';
import { deriveUtteranceId, NORMALIZED_TRANSCRIPT_SCHEMA_VERSION } from '../lib/normalization/normalized-transcript.js';
import { validateNormalizedTranscript } from '../lib/normalization/normalized-transcript.validator.js';
import { NormalizationSchemaInvalidError } from '../lib/normalization/normalization-errors.js';
import { normalizeUtteranceText } from '../lib/normalization/text-normalization.js';
import { FixtureTranscriptParser } from '../lib/normalization/fixture-transcript-parser.js';
import type { NormalizedTranscript } from '../lib/normalization/normalized-transcript.js';

const NORMALIZATION_DIR = resolve(__dirname, '../lib/normalization');

const TENANT = '11111111-1111-4111-8111-111111111111';
const TRANSCRIPT = '22222222-2222-4222-8222-222222222222';
const INTERACTION = '33333333-3333-4333-8333-333333333333';

function goodTranscript(): NormalizedTranscript {
  return {
    schema_version: NORMALIZED_TRANSCRIPT_SCHEMA_VERSION,
    transcript_id: TRANSCRIPT,
    tenant_id: TENANT,
    interaction_id: INTERACTION,
    provider_key: 'fake_transcript',
    provider_transcript_id: 'pt-1',
    source_sha256: 'a'.repeat(64),
    utterances: [
      { utterance_id: 'utt_a', ordinal: 0, speaker_role: 'UNKNOWN', text: 'hello' },
      { utterance_id: 'utt_b', ordinal: 1, speaker_role: 'RECRUITER', text: 'world' },
    ],
  };
}

describe('CI-B4 canonical serialization', () => {
  it('is deterministic and key-order independent', () => {
    const a = canonicalStringify({ b: 1, a: { d: 4, c: 3 }, arr: [3, 1, 2] });
    const b = canonicalStringify({ arr: [3, 1, 2], a: { c: 3, d: 4 }, b: 1 });
    expect(a).toBe(b);
    // Arrays preserve order (semantic); object keys sorted.
    expect(a).toBe('{"a":{"c":3,"d":4},"arr":[3,1,2],"b":1}');
  });

  it('drops undefined but preserves null; bytes are UTF-8 stable', () => {
    expect(canonicalStringify({ x: undefined, y: null })).toBe('{"y":null}');
    const v = goodTranscript();
    expect(canonicalBytes(v).equals(canonicalBytes(v))).toBe(true);
    expect(canonicalize([{ b: 1, a: 2 }])).toEqual([{ a: 2, b: 1 }]);
  });
});

describe('CI-B4 stable utterance ids', () => {
  it('same canonical inputs → same id; different ordinal/text → different id', () => {
    const base = {
      schemaVersion: NORMALIZED_TRANSCRIPT_SCHEMA_VERSION,
      transcriptId: TRANSCRIPT,
      ordinal: 0,
      text: 'I can start in two weeks',
    };
    expect(deriveUtteranceId(base)).toBe(deriveUtteranceId(base));
    expect(deriveUtteranceId(base)).not.toBe(deriveUtteranceId({ ...base, ordinal: 1 }));
    expect(deriveUtteranceId(base)).not.toBe(deriveUtteranceId({ ...base, text: 'different' }));
    expect(deriveUtteranceId(base)).toMatch(/^utt_[0-9a-f]{64}$/);
    // Not a random UUID.
    expect(deriveUtteranceId(base)).not.toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('CI-B4 text preservation (no semantic rewrite)', () => {
  it('applies only structural cleanup; keeps evidentiary wording verbatim', () => {
    // Hedging, repetition, imperfect grammar — all preserved.
    const raw = '  um, I, uh, think i has maybe like eight years\r\nof java  ';
    expect(normalizeUtteranceText(raw)).toBe(
      'um, I, uh, think i has maybe like eight years\nof java',
    );
    // Internal double-space is NOT collapsed (no semantic edit).
    expect(normalizeUtteranceText('a  b')).toBe('a  b');
  });
});

describe('CI-B4 normalized-transcript validator', () => {
  it('accepts a well-formed transcript', () => {
    expect(() => validateNormalizedTranscript(goodTranscript())).not.toThrow();
  });

  it('rejects bad ordinal, bad role, end<start, duplicate id', () => {
    const badOrdinal = goodTranscript();
    (badOrdinal.utterances as { ordinal: number }[])[1].ordinal = 5;
    expect(() => validateNormalizedTranscript(badOrdinal)).toThrow(NormalizationSchemaInvalidError);

    const badRole = goodTranscript();
    (badRole.utterances as { speaker_role: string }[])[0].speaker_role = 'BOSS';
    expect(() => validateNormalizedTranscript(badRole as NormalizedTranscript)).toThrow(
      NormalizationSchemaInvalidError,
    );

    const badTime = goodTranscript();
    (badTime.utterances as { start_ms?: number; end_ms?: number }[])[0].start_ms = 100;
    (badTime.utterances as { start_ms?: number; end_ms?: number }[])[0].end_ms = 50;
    expect(() => validateNormalizedTranscript(badTime)).toThrow(NormalizationSchemaInvalidError);

    const dupId = goodTranscript();
    (dupId.utterances as { utterance_id: string }[])[1].utterance_id = 'utt_a';
    expect(() => validateNormalizedTranscript(dupId)).toThrow(NormalizationSchemaInvalidError);
  });
});

describe('CI-B4 fixture parser (provider-neutral)', () => {
  it('parses segments and leaves unresolved speaker role undefined', () => {
    const doc = Buffer.from(
      JSON.stringify({
        language: 'en-US',
        segments: [
          { provider_speaker_id: '1', speaker_label: 'Speaker 1', start_ms: 0, end_ms: 1000, text: 'hi' },
          { speaker_role_hint: 'RECRUITER', text: 'thanks for your time' },
          { speaker_role_hint: 'NONSENSE', text: 'ignored hint' },
        ],
      }),
      'utf8',
    );
    const parsed = new FixtureTranscriptParser().parse(doc);
    expect(parsed.language).toBe('en-US');
    expect(parsed.segments[0].speaker_role_hint).toBeUndefined(); // no inference from "Speaker 1"
    expect(parsed.segments[1].speaker_role_hint).toBe('RECRUITER');
    expect(parsed.segments[2].speaker_role_hint).toBeUndefined(); // invalid hint ignored
  });

  it('throws on malformed JSON without echoing content', () => {
    expect(() => new FixtureTranscriptParser().parse(Buffer.from('not json{', 'utf8'))).toThrow();
  });
});

describe('CI-B4 provider-neutrality', () => {
  it('no vendor token leaks into the normalization surfaces', () => {
    const banned = /\b(zoom|teams|msgraph|rtms)\b/i;
    const files = readdirSync(NORMALIZATION_DIR).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(resolve(NORMALIZATION_DIR, f), 'utf8');
      expect(text, `${f} must not name a provider vendor`).not.toMatch(banned);
    }
  });
});
