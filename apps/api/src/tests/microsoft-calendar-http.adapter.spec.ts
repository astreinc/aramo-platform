import { GraphCalendarError } from '@aramo/microsoft-graph';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type GraphRetryPolicy,
  MicrosoftCalendarHttpAdapter,
} from '../microsoft/microsoft-calendar-http.adapter.js';

// COMM-C2B Amendment A1 (R3/R4/R6) — proofs for the Graph calendar adapter:
// create event carries attendees + Teams meeting + transactionId; provider errors
// are classified (401 reauth, 429 throttle, 5xx transient); transient failures on a
// mutating call are marked AMBIGUOUS; cancel is idempotent on an already-absent event.

function makeRes(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): Response {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
  } as unknown as Response;
}

function testPolicy(): GraphRetryPolicy & { sleep: ReturnType<typeof vi.fn> } {
  return { attempts: 3, baseDelayMs: 1, sleep: vi.fn().mockResolvedValue(undefined) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MicrosoftCalendarHttpAdapter (A1 R3/R4/R6)', () => {
  it('creates an event with attendees, a Teams meeting, and a transactionId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeRes(201, {
        id: 'evt-1',
        webLink: 'https://outlook/evt-1',
        onlineMeeting: { joinUrl: 'https://teams/join/1' },
        start: { dateTime: '2026-11-01T10:00:00', timeZone: 'America/New_York' },
        end: { dateTime: '2026-11-01T10:30:00', timeZone: 'America/New_York' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new MicrosoftCalendarHttpAdapter(testPolicy());

    const result = await adapter.createCalendarEvent({
      accessToken: 'tok',
      subject: 'Screen',
      startDateTime: '2026-11-01T10:00:00',
      endDateTime: '2026-11-01T10:30:00',
      timeZone: 'America/New_York',
      attendees: [{ email: 'talent@example.com', name: 'A Talent', type: 'required' }],
      isOnlineMeeting: true,
      transactionId: 'op-abc',
    });

    expect(result).toEqual({
      provider_event_id: 'evt-1',
      join_url: 'https://teams/join/1',
      web_link: 'https://outlook/evt-1',
      start_date_time: '2026-11-01T10:00:00',
      end_date_time: '2026-11-01T10:30:00',
      status: undefined,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/events');
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent['transactionId']).toBe('op-abc');
    expect(sent['isOnlineMeeting']).toBe(true);
    expect(sent['onlineMeetingProvider']).toBe('teamsForBusiness');
    expect(sent['attendees']).toEqual([
      { emailAddress: { address: 'talent@example.com', name: 'A Talent' }, type: 'required' },
    ]);
  });

  it('retries a 429 honoring Retry-After, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeRes(429, {}, { 'retry-after': '2' }))
      .mockResolvedValueOnce(makeRes(201, { id: 'evt-2', start: {}, end: {} }));
    vi.stubGlobal('fetch', fetchMock);
    const policy = testPolicy();
    const adapter = new MicrosoftCalendarHttpAdapter(policy);

    const result = await adapter.createCalendarEvent({
      accessToken: 'tok',
      subject: 's',
      startDateTime: 'a',
      endDateTime: 'b',
      timeZone: 'UTC',
      attendees: [],
      isOnlineMeeting: true,
      transactionId: 'op-2',
    });

    expect(result.provider_event_id).toBe('evt-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(policy.sleep).toHaveBeenCalledWith(2000); // Retry-After seconds → ms
  });

  it('classifies 401 as reauth_required and does NOT retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRes(401));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new MicrosoftCalendarHttpAdapter(testPolicy());

    await expect(
      adapter.createCalendarEvent({
        accessToken: 'tok',
        subject: 's',
        startDateTime: 'a',
        endDateTime: 'b',
        timeZone: 'UTC',
        attendees: [],
        isOnlineMeeting: true,
        transactionId: 'op-3',
      }),
    ).rejects.toMatchObject({ name: 'GraphCalendarError', kind: 'reauth_required', status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries on 5xx and throws a transient AMBIGUOUS error (R3)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRes(503));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new MicrosoftCalendarHttpAdapter(testPolicy());

    await expect(
      adapter.createCalendarEvent({
        accessToken: 'tok',
        subject: 's',
        startDateTime: 'a',
        endDateTime: 'b',
        timeZone: 'UTC',
        attendees: [],
        isOnlineMeeting: true,
        transactionId: 'op-4',
      }),
    ).rejects.toMatchObject({ kind: 'transient', ambiguous: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reschedules via PATCH on the same event id with only changed fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeRes(200, { id: 'evt-5', start: { dateTime: 'x' }, end: { dateTime: 'y' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new MicrosoftCalendarHttpAdapter(testPolicy());

    await adapter.updateCalendarEvent({
      accessToken: 'tok',
      providerEventId: 'evt-5',
      startDateTime: 'x',
      endDateTime: 'y',
      timeZone: 'UTC',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/events/evt-5');
    expect(init.method).toBe('PATCH');
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent).toHaveProperty('start');
    expect(sent).toHaveProperty('end');
    expect(sent).not.toHaveProperty('subject');
  });

  it('cancels the event; a 404 (already absent) is an idempotent success', async () => {
    const ok = vi.fn().mockResolvedValue(makeRes(202));
    vi.stubGlobal('fetch', ok);
    const adapter = new MicrosoftCalendarHttpAdapter(testPolicy());
    await expect(
      adapter.cancelCalendarEvent({ accessToken: 't', providerEventId: 'evt-6' }),
    ).resolves.toBeUndefined();

    const gone = vi.fn().mockResolvedValue(makeRes(404));
    vi.stubGlobal('fetch', gone);
    const adapter2 = new MicrosoftCalendarHttpAdapter(testPolicy());
    await expect(
      adapter2.cancelCalendarEvent({ accessToken: 't', providerEventId: 'evt-6' }),
    ).resolves.toBeUndefined();
  });

  it('getCalendarEvent returns null on 404 (reconciliation of unknown state)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRes(404));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new MicrosoftCalendarHttpAdapter(testPolicy());
    await expect(
      adapter.getCalendarEvent({ accessToken: 't', providerEventId: 'nope' }),
    ).resolves.toBeNull();
  });

  it('exports a GraphCalendarError usable for kind discrimination', () => {
    const e = new GraphCalendarError('throttled', 429, 'x', 5);
    expect(e.kind).toBe('throttled');
    expect(e.retryAfterSeconds).toBe(5);
  });
});
