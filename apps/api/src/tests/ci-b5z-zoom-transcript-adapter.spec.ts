import { describe, expect, it } from 'vitest';
import { InMemoryTranscriptArtifactStore } from '@aramo/conversation-transcript';

import { ZoomVttTranscriptParser } from '../conversation-transcript/zoom/zoom-vtt.parser.js';
import { ZoomRecordingTranscriptProvider, type ZoomConnectionSecretResolver } from '../conversation-transcript/zoom/zoom-recording-transcript.provider.js';
import { ZoomConnectionResolutionError } from '../conversation-transcript/zoom/zoom-recording-transcript.provider.js';
import {
  ZoomTranscriptHttpClient,
  ZOOM_TRANSCRIPT_ERROR_CODES,
  type FetchLike,
  type FetchResponseLike,
  type ZoomAccessTokenProvider,
} from '../conversation-transcript/zoom/zoom-transcript-http.client.js';
import { parseZoomRecordingTranscriptEvent } from '../conversation-transcript/zoom/zoom-recording-transcript-event.js';
import { ZOOM_RECORDING_TRANSCRIPT_COMPLETED_EVENT } from '../conversation-transcript/zoom/zoom-transcript.constants.js';

const VTT = [
  'WEBVTT',
  '',
  '1',
  '00:00:00.000 --> 00:00:02.500',
  '<v Recruiter>Hi, thanks for taking my call. um, are you still interested?',
  '',
  '2',
  '00:00:02.500 --> 00:00:05.000',
  '<v Speaker 2>Yeah, I, uh, think so',
  '',
].join('\n');

function res(status: number, opts: { headers?: Record<string, string>; body?: Buffer } = {}): FetchResponseLike {
  const headers = opts.headers ?? {};
  return {
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    arrayBuffer: async () => (opts.body ?? Buffer.alloc(0)),
  };
}

const tokens: ZoomAccessTokenProvider = {
  getAccessToken: async () => 'tok-1',
  refreshAccessToken: async () => 'tok-2',
};

const connResolver: ZoomConnectionSecretResolver = {
  resolveSecretRef: async () => 'connector:v1:tenant:conn',
};

describe('CI-B5Z — Zoom WEBVTT parser', () => {
  it('parses cues with speaker label + timestamps; preserves wording', () => {
    const parsed = new ZoomVttTranscriptParser().parse(Buffer.from(VTT, 'utf8'));
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0].speaker_label).toBe('Recruiter');
    expect(parsed.segments[0].start_ms).toBe(0);
    expect(parsed.segments[0].end_ms).toBe(2500);
    // Hedging/wording preserved (no semantic rewrite at the parser boundary).
    expect(parsed.segments[0].text).toContain('um, are you still interested?');
    // "Speaker 2" is a display label only — no role hint (no inference).
    expect(parsed.segments[1].speaker_label).toBe('Speaker 2');
    expect(parsed.segments[1].speaker_role_hint).toBeUndefined();
    // No provider_speaker_id fabricated from a voice display label.
    expect(parsed.segments[0].provider_speaker_id).toBeUndefined();
  });

  it('rejects a non-VTT (summary) object and empty transcripts', () => {
    expect(() => new ZoomVttTranscriptParser().parse(Buffer.from(JSON.stringify({ summary: 'x' }), 'utf8'))).toThrow();
    expect(() => new ZoomVttTranscriptParser().parse(Buffer.from('WEBVTT\n\n', 'utf8'))).toThrow();
  });
});

describe('CI-B5Z — Zoom transcript HTTP client (SSRF-safe, bounded, retry)', () => {
  const okFetch: (status: number, headers?: Record<string, string>, body?: Buffer) => FetchLike =
    (status, headers, body) => async () => res(status, { headers, body });

  it('downloads via the fixed official endpoint on 200', async () => {
    const client = new ZoomTranscriptHttpClient(tokens, okFetch(200, { 'content-type': 'text/vtt' }, Buffer.from(VTT)));
    const out = await client.downloadRecordingTranscript({ tenantSecretRef: 's', recordingId: 'rec-1' });
    expect(out.bytes.toString('utf8')).toContain('WEBVTT');
  });

  it('429 → retryable with Retry-After', async () => {
    const client = new ZoomTranscriptHttpClient(tokens, okFetch(429, { 'retry-after': '30' }));
    await expect(client.downloadRecordingTranscript({ tenantSecretRef: 's', recordingId: 'r' })).rejects.toMatchObject({
      code: ZOOM_TRANSCRIPT_ERROR_CODES.RETRYABLE_RATE_LIMITED,
      retryable: true,
      retryAfterSeconds: 30,
    });
  });

  it('5xx → retryable; 404 → retryable not-ready; 403 → terminal', async () => {
    await expect(new ZoomTranscriptHttpClient(tokens, okFetch(503)).downloadRecordingTranscript({ tenantSecretRef: 's', recordingId: 'r' })).rejects.toMatchObject({ code: ZOOM_TRANSCRIPT_ERROR_CODES.RETRYABLE_SERVER, retryable: true });
    await expect(new ZoomTranscriptHttpClient(tokens, okFetch(404)).downloadRecordingTranscript({ tenantSecretRef: 's', recordingId: 'r' })).rejects.toMatchObject({ code: ZOOM_TRANSCRIPT_ERROR_CODES.RETRYABLE_NOT_READY, retryable: true });
    await expect(new ZoomTranscriptHttpClient(tokens, okFetch(403)).downloadRecordingTranscript({ tenantSecretRef: 's', recordingId: 'r' })).rejects.toMatchObject({ code: ZOOM_TRANSCRIPT_ERROR_CODES.TERMINAL_FORBIDDEN, retryable: false });
  });

  it('401 → refreshes token once, then succeeds', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async (_url, init) => {
      calls += 1;
      if (init.headers['authorization'] === 'Bearer tok-1') return res(401);
      return res(200, { body: Buffer.from(VTT) });
    };
    const out = await new ZoomTranscriptHttpClient(tokens, fetchImpl).downloadRecordingTranscript({ tenantSecretRef: 's', recordingId: 'r' });
    expect(calls).toBe(2);
    expect(out.bytes.toString('utf8')).toContain('WEBVTT');
  });

  it('rejects an unsafe redirect host (SSRF)', async () => {
    const fetchImpl: FetchLike = async () => res(302, { headers: { location: 'https://169.254.169.254/latest/meta-data' } });
    await expect(new ZoomTranscriptHttpClient(tokens, fetchImpl).downloadRecordingTranscript({ tenantSecretRef: 's', recordingId: 'r' })).rejects.toMatchObject({ code: ZOOM_TRANSCRIPT_ERROR_CODES.TERMINAL_UNSAFE_REDIRECT });
  });

  it('follows a safe *.zoom.us redirect', async () => {
    let hop = 0;
    const fetchImpl: FetchLike = async () => {
      hop += 1;
      if (hop === 1) return res(302, { headers: { location: 'https://cdn.zoom.us/signed/abc' } });
      return res(200, { body: Buffer.from(VTT) });
    };
    const out = await new ZoomTranscriptHttpClient(tokens, fetchImpl).downloadRecordingTranscript({ tenantSecretRef: 's', recordingId: 'r' });
    expect(out.bytes.toString('utf8')).toContain('WEBVTT');
  });

  it('rejects an oversized response', async () => {
    const client = new ZoomTranscriptHttpClient(tokens, okFetch(200, { 'content-length': String(50 * 1024 * 1024) }, Buffer.from(VTT)), 20_000, 1024);
    await expect(client.downloadRecordingTranscript({ tenantSecretRef: 's', recordingId: 'r' })).rejects.toMatchObject({ code: ZOOM_TRANSCRIPT_ERROR_CODES.TERMINAL_TOO_LARGE });
  });
});

describe('CI-B5Z — Zoom provider adapter (B3 contract)', () => {
  function provider(fetchImpl: FetchLike, store = new InMemoryTranscriptArtifactStore()) {
    const client = new ZoomTranscriptHttpClient(tokens, fetchImpl);
    return { store, p: new ZoomRecordingTranscriptProvider(client, store, connResolver) };
  }
  const okFetch: FetchLike = async () => res(200, { headers: { 'content-type': 'text/vtt' }, body: Buffer.from(VTT) });

  it('declares the implemented recording-transcript capability (recording required, live false)', () => {
    const caps = provider(okFetch).p.getCapabilities();
    expect(caps.full_post_conversation_transcript).toBe(true);
    expect(caps.recording_dependency).toBe('required');
    expect(caps.live_transcript_stream).toBe(false);
  });

  it('acquires: writes raw evidence via putSource, returns opaque ref + sha', async () => {
    const { store, p } = provider(okFetch);
    const out = await p.acquireTranscript({ tenant_id: 't1', provider_key: 'zoom_phone', provider_transcript_id: 'pt-1', provider_resource_ref: 'rec-1' });
    expect(out.kind).toBe('acquired');
    if (out.kind !== 'acquired') return;
    expect(out.result.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.result.source_type).toBe('provider_full_transcript');
    expect(store.putSourceCallCount).toBe(1);
    // The raw evidence is retrievable and is the exact VTT bytes.
    const bytes = await store.getSource('t1', out.result.source_artifact_ref);
    expect(bytes.toString('utf8')).toContain('WEBVTT');
    // Opaque ref — no URL, tenant-scoped.
    expect(out.result.source_artifact_ref).toMatch(/^conversation-transcript\/t1\//);
    expect(out.result.source_artifact_ref).not.toMatch(/https?:/);
  });

  it('rejects a summary object at the boundary (terminal, not stored as valid)', async () => {
    const summaryFetch: FetchLike = async () => res(200, { body: Buffer.from(JSON.stringify({ ai_summary: 'x' })) });
    const out = await provider(summaryFetch).p.acquireTranscript({ tenant_id: 't', provider_key: 'zoom_phone', provider_transcript_id: 'pt', provider_resource_ref: 'rec' });
    expect(out).toEqual({ kind: 'terminal_failure', error_code: 'ZOOM_TRANSCRIPT_NOT_A_TRANSCRIPT' });
  });

  it('maps a retryable fetch failure to retryable_failure', async () => {
    const failFetch: FetchLike = async () => res(503);
    const out = await provider(failFetch).p.acquireTranscript({ tenant_id: 't', provider_key: 'zoom_phone', provider_transcript_id: 'pt', provider_resource_ref: 'rec' });
    expect(out.kind).toBe('retryable_failure');
  });

  it('missing recording identity → terminal', async () => {
    const out = await provider(okFetch).p.acquireTranscript({ tenant_id: 't', provider_key: 'zoom_phone', provider_transcript_id: 'pt' });
    expect(out).toEqual({ kind: 'terminal_failure', error_code: 'ZOOM_TRANSCRIPT_INVALID_IDENTITY' });
  });

  it('connection resolution failure maps by retryable flag', async () => {
    const client = new ZoomTranscriptHttpClient(tokens, okFetch);
    const deny: ZoomConnectionSecretResolver = { resolveSecretRef: async () => { throw new ZoomConnectionResolutionError('X', false); } };
    const p = new ZoomRecordingTranscriptProvider(client, new InMemoryTranscriptArtifactStore(), deny);
    const out = await p.acquireTranscript({ tenant_id: 't', provider_key: 'zoom_phone', provider_transcript_id: 'pt', provider_resource_ref: 'rec' });
    expect(out).toEqual({ kind: 'terminal_failure', error_code: 'X' });
  });

  it('resolveTranscriptReference maps the completed event to a neutral reference', () => {
    const ref = provider(okFetch).p.resolveTranscriptReference({
      event: ZOOM_RECORDING_TRANSCRIPT_COMPLETED_EVENT,
      payload: { object: { recording_id: 'rec-9', transcript_id: 'tr-9' } },
    });
    expect(ref).toEqual({ provider_transcript_id: 'tr-9', provider_resource_ref: 'rec-9' });
  });
});

describe('CI-B5Z — event parser', () => {
  it('extracts recording/transcript/correlation ids; captures but does not surface the ephemeral url downstream', () => {
    const view = parseZoomRecordingTranscriptEvent({
      payload: { object: { recording_id: 'rec-1', call_history_id: 'ch-1', download_url: 'https://api.zoom.us/x' } },
    });
    expect(view).not.toBeNull();
    expect(view?.recording_id).toBe('rec-1');
    expect(view?.provider_transcript_id).toBe('rec-1'); // falls back to recording id
    expect(view?.call_history_id).toBe('ch-1');
    // download_url stays in the ephemeral field (never persisted by callers).
    expect(view?.ephemeral_download_url).toBe('https://api.zoom.us/x');
  });

  it('returns null for a payload without a recording id', () => {
    expect(parseZoomRecordingTranscriptEvent({ payload: { object: {} } })).toBeNull();
  });
});
