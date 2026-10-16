import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import {
  FakeExternalCaptureProvider,
  type ExternalCaptureEvent,
} from '@aramo/conversation-transcript';
import { describe, expect, it, vi } from 'vitest';

import {
  LIVE_ASSIST_FINALS_PER_REQUEST,
  LiveScreeningAssistCoordinator,
} from '../../technical-screening/live-screening-assist.coordinator.js';

// TIP-E2E INC-3 A1-6 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED §9, §5, C-2, R-C) —
// the live assistance path, verified ONLY against the fake provider:
//   - no provider command without transcription + ai_processing (+ recording)
//     confirmed before the join;
//   - signed, fresh, idempotent intake; tampering and replays change nothing;
//   - suggestions (existing TRANSCRIPT_SEGMENTS trigger) only for an admitted,
//     consented feed, bounded per N final segments, best-effort;
//   - a participant objection stops, purges and deletes;
//   - no production code registers the fake or the coordinator (R-C).

const SECRET = 'live-secret';
const NOW = 1_800_000_000_000;
const TENANT = 't-1';

function consentPort(map: Record<string, boolean>) {
  return { isOperationAllowed: vi.fn(async (_t: string, _r: string, op: string) => map[op] ?? false) };
}

function build(opts: { consent?: Record<string, boolean>; records?: boolean; failAssist?: boolean } = {}) {
  const provider = new FakeExternalCaptureProvider(SECRET, { records_media: opts.records ?? false });
  const consent = consentPort(opts.consent ?? { transcription: true, ai_processing: true });
  const assist = {
    suggestFollowUps: vi.fn(async () => {
      if (opts.failAssist === true) throw new Error('model down');
      return [];
    }),
  };
  const coordinator = new LiveScreeningAssistCoordinator(provider, SECRET, consent, assist, () => NOW);
  return { provider, consent, assist, coordinator };
}

const startArgs = {
  tenant_id: TENANT, session_id: 's-1', talent_record_id: 'tal-1', actor_id: 'r-1', meeting_ref: 'int-1',
  join_url: 'https://teams/join', bot_display_name: 'Aramo notetaker', plan: ['Q1'], requestId: 'rq',
};

function events(psid: string) {
  const env = (type: string, payload: unknown, id: string) =>
    ({ event_id: id, type, provider: 'fake_external_capture', provider_session_id: psid, aramo_tenant_id: TENANT, meeting_ref: 'int-1', occurred_at: 'x', payload }) as ExternalCaptureEvent;
  return {
    started: (admitted: boolean) => env('session_started', { joined_at: 'x', capture_mode: 'live', bot_display_name: 'Aramo notetaker', admitted }, `start-${admitted}`),
    final: (n: number) =>
      env('transcript_segment', { segment_id: `seg-${n}`, revision: 1, kind: 'final', speaker: { provider_participant_id: 'p', display_name: null, attribution: 'separate_stream' }, start_ms: n * 1000, end_ms: n * 1000 + 900, text: `answer ${n}` }, `seg-${n}`),
    ready: () => env('artifact_ready', { type: 'transcript', format: 'vtt', url: 'https://x', url_expires_at: 'y', retention_expires_at: null }, 'ready-1'),
  };
}

describe('LiveScreeningAssistCoordinator — fake provider only (A1-6)', () => {
  it('refuses to start (no provider command) without transcription and ai_processing, or recording when the provider records', async () => {
    for (const [consent, records] of [
      [{ transcription: true, ai_processing: false }, false],
      [{ transcription: false, ai_processing: true }, false],
      [{ transcription: true, ai_processing: true, recording: false }, true],
    ] as const) {
      const c = build({ consent, records });
      await expect(c.coordinator.startCapture(startArgs)).rejects.toMatchObject({
        code: 'INSUFFICIENT_PERMISSIONS',
        context: { details: { reason: 'capture_consent_missing' } },
      });
      expect(c.provider.commands).toEqual([]);
    }
  });

  it('admitted + consented: bounded suggestions with the TRANSCRIPT_SEGMENTS trigger; tampered and replayed deliveries change nothing', async () => {
    const c = build();
    const h = await c.coordinator.startCapture(startArgs);
    const e = events(h.provider_session_id);
    expect((await c.coordinator.ingest(h, c.provider.deliver(e.started(true), NOW))).status).toBe('applied');
    for (let n = 1; n < LIVE_ASSIST_FINALS_PER_REQUEST; n++) {
      expect(await c.coordinator.ingest(h, c.provider.deliver(e.final(n), NOW))).toMatchObject({ suggested: 'no', assist: 'allowed' });
    }
    const third = await c.coordinator.ingest(h, c.provider.deliver(e.final(LIVE_ASSIST_FINALS_PER_REQUEST), NOW));
    expect(third).toMatchObject({ status: 'applied', suggested: 'yes' });
    expect(c.assist.suggestFollowUps).toHaveBeenCalledOnce();
    expect(c.assist.suggestFollowUps).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 's-1',
      talent_record_id: 'tal-1',
      trigger: { kind: 'TRANSCRIPT_SEGMENTS', segment_ids: ['seg-1', 'seg-2', 'seg-3'], text: 'answer 1\nanswer 2\nanswer 3' },
    }));

    const replay = await c.coordinator.ingest(h, c.provider.deliver(e.final(1), NOW));
    expect(replay).toEqual({ status: 'ignored', reason: 'duplicate' });
    const d = c.provider.deliver(e.final(9), NOW);
    expect(await c.coordinator.ingest(h, { ...d, rawBody: d.rawBody.replace('answer 9', 'answer X') })).toEqual({ status: 'rejected', reason: 'signature_invalid' });
    expect(await c.coordinator.ingest(h, c.provider.deliver(e.final(10), NOW - 60 * 60 * 1000))).toEqual({ status: 'rejected', reason: 'stale' });
    const foreign = { ...e.final(11), aramo_tenant_id: 't-2' } as ExternalCaptureEvent;
    expect(await c.coordinator.ingest(h, c.provider.deliver(foreign, NOW))).toEqual({ status: 'rejected', reason: 'tenant_mismatch' });
    expect(c.assist.suggestFollowUps).toHaveBeenCalledOnce();
  });

  it('a feed held in the lobby (admitted:false) never produces suggestions', async () => {
    const c = build();
    const h = await c.coordinator.startCapture(startArgs);
    const e = events(h.provider_session_id);
    await c.coordinator.ingest(h, c.provider.deliver(e.started(false), NOW));
    for (let n = 1; n <= LIVE_ASSIST_FINALS_PER_REQUEST * 2; n++) {
      expect(await c.coordinator.ingest(h, c.provider.deliver(e.final(n), NOW))).toMatchObject({ suggested: 'no', assist: 'not_admitted' });
    }
    expect(c.assist.suggestFollowUps).not.toHaveBeenCalled();
  });

  it('a failing suggestion call is contained (best-effort); artifact_ready is surfaced for B3 intake', async () => {
    const c = build({ failAssist: true });
    const h = await c.coordinator.startCapture(startArgs);
    const e = events(h.provider_session_id);
    await c.coordinator.ingest(h, c.provider.deliver(e.started(true), NOW));
    let last;
    for (let n = 1; n <= LIVE_ASSIST_FINALS_PER_REQUEST; n++) last = await c.coordinator.ingest(h, c.provider.deliver(e.final(n), NOW));
    expect(last).toMatchObject({ status: 'applied', suggested: 'failed' });
    expect(await c.coordinator.ingest(h, c.provider.deliver(e.ready(), NOW))).toMatchObject({ artifact_ready: h.provider_session_id });
  });

  it('a participant objection stops capture, purges the live window and deletes provider artifacts', async () => {
    const c = build();
    const h = await c.coordinator.startCapture(startArgs);
    const e = events(h.provider_session_id);
    await c.coordinator.ingest(h, c.provider.deliver(e.started(true), NOW));
    await c.coordinator.ingest(h, c.provider.deliver(e.final(1), NOW));
    expect(h.buffer.size).toBe(1);
    expect(await c.coordinator.objection(h)).toEqual({ deletion_confirmed: true });
    expect(h.buffer.size).toBe(0);
    expect(c.provider.commands.map((x) => [x.kind, x.reason ?? null])).toEqual([
      ['start', null],
      ['stop', 'participant_objection'],
      ['delete', null],
    ]);
  });

  it('R-C: no production source registers the fake provider or the live coordinator', () => {
    const root = resolve(__dirname, '../../../../..');
    const grep = (pattern: string): string[] => {
      try {
        return execFileSync('git', ['grep', '-l', pattern, '--', 'apps', 'libs'], { cwd: root, encoding: 'utf8' })
          .split('\n')
          .filter((f) => f.length > 0 && !/\/tests?\//.test(f) && !f.endsWith('.spec.ts'));
      } catch {
        return [];
      }
    };
    expect(grep('FakeExternalCaptureProvider').sort()).toEqual([
      'libs/conversation-transcript/src/index.ts',
      'libs/conversation-transcript/src/lib/live/fake-external-capture.provider.ts',
    ]);
    expect(grep('LiveScreeningAssistCoordinator')).toEqual(['apps/api/src/technical-screening/live-screening-assist.coordinator.ts']);
  });
});
