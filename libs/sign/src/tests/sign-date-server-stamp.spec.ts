import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/identity-verification/identity-gate.js', () => ({ assertIdentityVerificationCleared: vi.fn(async () => undefined) }));
vi.mock('../lib/regulated/qes-guard.js', () => ({ assertQesSatisfied: vi.fn(async () => undefined) }));

import { formatSignDate, resolveSignerTimeZone } from '../lib/domain/sign-date.js';
import { EsignService, type SessionContext } from '../lib/esign.service.js';

// Aramo-Sign-Client-Rule-Consolidation-Directive-v1_0-LOCKED §2 C0-2 — the server stamps
// SIGN_DATE when the signer submits: the envelope's stamped date_format applied to the
// signer's calendar date in the signer's time zone (validated; UTC otherwise). Any value a
// client sends for a SIGN_DATE is ignored.

describe('C0-2 — formatSignDate in the signer time zone', () => {
  const boundary = new Date('2026-11-21T02:00:00Z');

  it('a date boundary: 02:00Z on Nov 21 is still Nov 20 in America/New_York', () => {
    expect(formatSignDate(boundary, 'YYYY-MM-DD', 'America/New_York')).toBe('2026-11-20');
    expect(formatSignDate(boundary, 'YYYY-MM-DD', 'UTC')).toBe('2026-11-21');
    expect(formatSignDate(boundary, 'YYYY-MM-DD', 'Asia/Kolkata')).toBe('2026-11-21');
  });

  it('the other direction: 20:00Z on Nov 20 is already Nov 21 in Asia/Tokyo', () => {
    expect(formatSignDate(new Date('2026-11-20T20:00:00Z'), 'MM/DD/YYYY', 'Asia/Tokyo')).toBe('11/21/2026');
  });

  it.each([
    ['MM/DD/YYYY', '11/20/2026'],
    ['DD/MM/YYYY', '20/11/2026'],
    ['YYYY-MM-DD', '2026-11-20'],
    [null, '11/20/2026'],
    ['not-a-format', '11/20/2026'],
  ])('format %s in America/New_York → %s', (format, expected) => {
    expect(formatSignDate(boundary, format, 'America/New_York')).toBe(expected);
  });

  it('defaults to UTC, so existing callers are unchanged', () => {
    expect(formatSignDate(boundary, 'YYYY-MM-DD')).toBe('2026-11-21');
    expect(formatSignDate(new Date(Date.UTC(2026, 10, 4, 12)), 'DD/MM/YYYY')).toBe('04/11/2026');
  });

  it('an invalid time zone is formatted as UTC', () => {
    expect(formatSignDate(boundary, 'YYYY-MM-DD', 'Mars/Olympus_Mons')).toBe('2026-11-21');
  });
});

describe('C0-2 — resolveSignerTimeZone', () => {
  it('keeps a supported IANA zone', () => {
    expect(resolveSignerTimeZone('America/New_York')).toBe('America/New_York');
    expect(resolveSignerTimeZone('Europe/London')).toBe('Europe/London');
  });

  it('keeps an alias Intl resolves (some devices report Asia/Calcutta) and UTC', () => {
    expect(resolveSignerTimeZone('Asia/Calcutta')).toBe('Asia/Calcutta');
    expect(resolveSignerTimeZone('UTC')).toBe('UTC');
  });

  it.each([[undefined], [null], [42], [''], ['Mars/Olympus_Mons'], ['America/New_York; DROP'], ['x'.repeat(65)]])('falls back to UTC for %p', (input) => {
    expect(resolveSignerTimeZone(input)).toBe('UTC');
  });
});

// The engine: fillField and completeSigner with a stubbed transaction (the gates are
// exercised by the integration specs; here only the SIGN_DATE value is under test).
const ctx: SessionContext = { session_id: 'sess-1', tenant_id: 't1', envelope_id: 'e1', signer_id: 's1' };

function engine(opts: { date_format: string | null; fields: Record<string, unknown>[] }) {
  const updates: { id: string; data: Record<string, unknown> }[] = [];
  const tx = {
    signatureField: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => opts.fields.find((f) => f['id'] === where.id) ?? null),
      findMany: vi.fn(async () => opts.fields),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, data });
        return {};
      }),
    },
    signatureEnvelope: {
      findFirst: vi.fn(async () => ({ signer_date_format: opts.date_format })),
      findFirstOrThrow: vi.fn(async () => ({ routing_mode: 'PARALLEL' })),
    },
    signer: {
      update: vi.fn(async () => ({})),
      // Another signer is still pending: the envelope stays IN_PROGRESS (no execution).
      findMany: vi.fn(async () => [
        { id: 's1', status: 'SIGNED', recipient_kind: 'SIGNER', signing_order: 1, witness_for_signer_id: null },
        { id: 's2', status: 'PENDING', recipient_kind: 'SIGNER', signing_order: 2, witness_for_signer_id: null },
      ]),
    },
    signingSession: { update: vi.fn(async () => ({})) },
  };
  const prisma = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  const repo = { lockSignableEnvelope: vi.fn(async () => 'IN_PROGRESS'), appendEvent: vi.fn(async () => 'ev-1') };
  const svc = new EsignService(prisma as never, repo as never, {} as never);
  const gates = svc as unknown as Record<string, unknown>;
  gates['assertLiveSession'] = vi.fn(async () => ({ origin: null, host_user_id: null, authenticated_user_id: null }));
  gates['assertEligible'] = vi.fn(async () => undefined);
  gates['assertAccessCodeCleared'] = vi.fn(async () => undefined);
  gates['hasAcceptedDisclosure'] = vi.fn(async () => true);
  return { svc, updates, tx };
}

const dateField = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  field_type: 'SIGN_DATE',
  required: true,
  value: null,
  filled_at: null,
  name_mode: null,
  group_key: null,
  group_rule: null,
  min_selected: null,
  ...over,
});

describe('C0-2 — the server stamps SIGN_DATE (client value ignored)', () => {
  afterEach(() => vi.useRealTimers());

  it('fillField ignores the client SIGN_DATE value and stores the server date', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-21T02:00:00Z'), toFake: ['Date'] });
    const { svc, updates } = engine({ date_format: 'DD/MM/YYYY', fields: [dateField('d1')] });
    await svc.fillField(ctx, 'd1', { value: '01/01/1999', signature_method: 'TYPED', time_zone: 'America/New_York' });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.data).toMatchObject({ value: '20/11/2026', signature_method: null });
  });

  it('fillField with an invalid time zone stamps the UTC date', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-21T02:00:00Z'), toFake: ['Date'] });
    const { svc, updates } = engine({ date_format: 'YYYY-MM-DD', fields: [dateField('d1')] });
    await svc.fillField(ctx, 'd1', { value: '1999-01-01', time_zone: 'Not/AZone' });
    expect(updates[0]?.data['value']).toBe('2026-11-21');
  });

  it('fillField of another field type keeps the client value', async () => {
    const { svc, updates } = engine({ date_format: null, fields: [dateField('t1', { field_type: 'TEXT' })] });
    await svc.fillField(ctx, 't1', { value: 'hello', time_zone: 'America/New_York' });
    expect(updates[0]?.data['value']).toBe('hello');
  });

  it('completeSigner overwrites every SIGN_DATE of the signer (even one the client never filled)', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-21T02:00:00Z'), toFake: ['Date'] });
    const filledByClient = dateField('d1', { value: '01/01/1999', filled_at: new Date('2026-11-01T00:00:00Z') });
    const untouched = dateField('d2');
    const sig = { ...dateField('sig'), field_type: 'SIGNATURE', value: 'data:image/png;base64,AAA', filled_at: new Date() };
    const { svc, updates } = engine({ date_format: 'MM/DD/YYYY', fields: [filledByClient, untouched, sig] });
    const r = await svc.completeSigner(ctx, { time_zone: 'America/New_York' });
    expect(r.envelope_status).toBe('IN_PROGRESS');
    expect(updates.map((u) => [u.id, u.data['value']])).toEqual([
      ['d1', '11/20/2026'],
      ['d2', '11/20/2026'],
    ]);
  });

  it('completeSigner without a time zone stamps the UTC date; a null envelope format uses MM/DD/YYYY', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-21T02:00:00Z'), toFake: ['Date'] });
    const { svc, updates } = engine({ date_format: null, fields: [dateField('d1')] });
    await svc.completeSigner(ctx);
    expect(updates[0]?.data['value']).toBe('11/21/2026');
  });

  it('a signer who has already signed is refused before any stamp (never re-stamped)', async () => {
    const { svc, updates } = engine({ date_format: 'YYYY-MM-DD', fields: [dateField('d1', { value: '2026-11-01', filled_at: new Date() })] });
    (svc as unknown as Record<string, unknown>)['assertLiveSession'] = vi.fn(async () => {
      throw new Error('session completed');
    });
    await expect(svc.completeSigner(ctx, { time_zone: 'UTC' })).rejects.toThrow('session completed');
    expect(updates).toHaveLength(0);
  });
});
