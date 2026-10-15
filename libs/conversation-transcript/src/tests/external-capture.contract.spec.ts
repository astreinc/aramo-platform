import { describe, expect, it } from 'vitest';

import {
  ExternalCaptureEventError,
  LiveCaptureSessionBuffer,
  evaluateLiveAssist,
  parseExternalCaptureEvent,
  signExternalCaptureEvent,
  verifyExternalCaptureSignature,
  type ExternalCaptureEvent,
} from '../lib/live/external-capture.contract.js';
import { FakeExternalCaptureProvider } from '../lib/live/fake-external-capture.provider.js';

// TIP-E2E INC-3 A1-6 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED §9) — the provider-
// neutral capture contract: signed + fresh + strictly parsed events, idempotent
// apply, final supersedes partial, tenant/session binding, nothing retained
// after end, and the fail-closed live-assist decision.

const SECRET = 'test-secret';
const NOW = 1_800_000_000_000;
const TENANT = 't-1';
const PSID = 'ps-1';

function envelope<T extends ExternalCaptureEvent['type']>(type: T, payload: unknown, id = `${type}-1`): ExternalCaptureEvent {
  return {
    event_id: id,
    type,
    provider: 'fake_external_capture',
    provider_session_id: PSID,
    aramo_tenant_id: TENANT,
    meeting_ref: 'int-1',
    occurred_at: '2026-11-01T10:00:00Z',
    payload,
  } as ExternalCaptureEvent;
}
const segment = (id: string, revision: number, kind: 'partial' | 'final', text: string, start = 0) =>
  envelope('transcript_segment', {
    segment_id: id,
    revision,
    kind,
    speaker: { provider_participant_id: 'p1', display_name: null, attribution: 'separate_stream' },
    start_ms: start,
    end_ms: start + 1000,
    text,
  }, `${id}-r${revision}-${kind}`);

describe('external capture contract (§9)', () => {
  it('accepts a correctly signed fresh delivery; refuses tampering, a wrong secret and stale timestamps', () => {
    const body = JSON.stringify(segment('s1', 1, 'final', 'hello'));
    const sig = signExternalCaptureEvent(SECRET, String(NOW), body);
    expect(() => verifyExternalCaptureSignature({ secret: SECRET, timestamp: String(NOW), signature: sig, rawBody: body, nowMs: NOW })).not.toThrow();
    for (const bad of [
      { rawBody: body.replace('hello', 'HELLO') },
      { secret: 'other' },
      { signature: 'zz' },
      { timestamp: String(NOW - 10 * 60 * 1000) },
    ]) {
      const args = { secret: SECRET, timestamp: String(NOW), signature: sig, rawBody: body, nowMs: NOW, ...bad };
      expect(() => verifyExternalCaptureSignature(args)).toThrow(ExternalCaptureEventError);
    }
  });

  it('parses strictly: unknown type, missing envelope fields or malformed segments are refused', () => {
    expect(parseExternalCaptureEvent(JSON.stringify(segment('s1', 1, 'final', 'x'))).type).toBe('transcript_segment');
    expect(() => parseExternalCaptureEvent(JSON.stringify({ ...segment('s1', 1, 'final', 'x'), type: 'bot_chat' }))).toThrow(ExternalCaptureEventError);
    expect(() => parseExternalCaptureEvent(JSON.stringify({ ...segment('s1', 1, 'final', 'x'), aramo_tenant_id: '' }))).toThrow(ExternalCaptureEventError);
    const broken = segment('s1', 1, 'final', 'x') as { payload: Record<string, unknown> };
    expect(() => parseExternalCaptureEvent(JSON.stringify({ ...broken, payload: { ...broken.payload, end_ms: -1 } }))).toThrow(ExternalCaptureEventError);
    expect(() => parseExternalCaptureEvent('{not json')).toThrow(ExternalCaptureEventError);
  });

  it('applies idempotently; final supersedes partial; an older revision never overwrites', () => {
    const b = new LiveCaptureSessionBuffer(TENANT, PSID);
    expect(b.apply(segment('s1', 1, 'partial', 'I ran')).applied).toBe(true);
    expect(b.apply(segment('s1', 1, 'partial', 'I ran'))).toEqual({ applied: false, reason: 'duplicate' });
    expect(b.apply(segment('s1', 2, 'final', 'I ran three clusters')).applied).toBe(true);
    expect(b.apply(segment('s1', 3, 'partial', 'I ran four'))).toEqual({ applied: false, reason: 'superseded' });
    expect(b.apply(segment('s1', 1, 'final', 'stale final'))).toEqual({ applied: false, reason: 'superseded' });
    expect(b.finalWindow().map((s) => s.text)).toEqual(['I ran three clusters']);
  });

  it('refuses another tenant or provider session; holds nothing after session_ended', () => {
    const b = new LiveCaptureSessionBuffer(TENANT, PSID);
    expect(() => b.apply({ ...segment('s1', 1, 'final', 'x'), aramo_tenant_id: 't-2' } as ExternalCaptureEvent)).toThrow(ExternalCaptureEventError);
    expect(() => b.apply({ ...segment('s1', 1, 'final', 'x'), provider_session_id: 'ps-9' } as ExternalCaptureEvent)).toThrow(ExternalCaptureEventError);
    b.apply(envelope('session_started', { joined_at: 'x', capture_mode: 'live', bot_display_name: 'Aramo notetaker', admitted: true }));
    b.apply(segment('s1', 1, 'final', 'hello'));
    expect(b.admitted).toBe(true);
    b.apply(envelope('session_ended', { ended_at: 'y', reason: 'meeting_ended' }));
    expect(b.size).toBe(0);
    expect(b.admitted).toBe(false);
    expect(b.apply(segment('s2', 1, 'final', 'late'))).toEqual({ applied: false, reason: 'ended' });
  });

  it('live assist fails closed: not admitted, consent missing, recording missing when the provider records, consent after join', () => {
    const ok = { transcription: true, ai_processing: true, recording: false, provider_records: false, confirmed_before_join: true };
    expect(evaluateLiveAssist({ admitted: true, consent: ok })).toEqual({ allowed: true });
    expect(evaluateLiveAssist({ admitted: false, consent: ok })).toEqual({ allowed: false, reason: 'not_admitted' });
    expect(evaluateLiveAssist({ admitted: true, consent: { ...ok, ai_processing: false } })).toEqual({ allowed: false, reason: 'consent_missing' });
    expect(evaluateLiveAssist({ admitted: true, consent: { ...ok, provider_records: true } })).toEqual({ allowed: false, reason: 'consent_missing' });
    expect(evaluateLiveAssist({ admitted: true, consent: { ...ok, confirmed_before_join: false } })).toEqual({ allowed: false, reason: 'consent_after_join' });
  });

  it('the fake provider honours the B3 port: artifact acquisition, and nothing after delete', async () => {
    const p = new FakeExternalCaptureProvider(SECRET);
    p.stageArtifact(PSID, 'WEBVTT');
    const got = await p.acquireTranscript({ tenant_id: TENANT, provider_key: p.providerKey(), provider_transcript_id: PSID });
    expect(got.kind).toBe('acquired');
    expect(await p.deleteArtifacts({ provider_session_id: PSID })).toEqual({ confirmed: true });
    expect((await p.acquireTranscript({ tenant_id: TENANT, provider_key: p.providerKey(), provider_transcript_id: PSID })).kind).toBe('terminal_failure');
  });
});
