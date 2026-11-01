import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { TrustedTimestampService } from '../lib/trusted-timestamp/trusted-timestamp.service.js';
import { trustedTimestampBlocks } from '../lib/execution.service.js';
import type { TrustedTimestampPort, TrustedTimestampToken } from '../lib/ports/trusted-timestamp.port.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// Feature-Parity Directive v1.0 §1.18 — the timestamp lifecycle (PENDING → GRANTED),
// "never blocks completion", and the backoff retry, over an in-memory table.

type Row = Record<string, unknown> & { id: string; status: string; next_attempt_at: Date | null; attempt_count: number };

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Record<string, unknown>[]).some((w) => matches(row, w));
    if (v !== null && typeof v === 'object' && !(v instanceof Date) && 'lte' in (v as object)) {
      const cell = row[k] as Date | null;
      return cell !== null && cell.getTime() <= ((v as { lte: Date }).lte).getTime();
    }
    const cell = row[k] ?? null;
    if (v instanceof Date || cell instanceof Date) return (cell as Date | null)?.getTime() === (v as Date | null)?.getTime();
    return cell === v;
  });
}

function fakePrisma(): { prisma: PrismaService; rows: Row[] } {
  const rows: Row[] = [];
  const table = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
    findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) => rows.filter((r) => matches(r, where)).slice(0, take ?? rows.length)),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (rows.some((r) => r['envelope_id'] === data['envelope_id'] && r['subject_kind'] === data['subject_kind'] && (r['envelope_document_id'] ?? null) === (data['envelope_document_id'] ?? null))) {
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      }
      const row = { attempt_count: 0, next_attempt_at: null, hash_algorithm: 'SHA-256', token_der: null, gen_time: null, serial_number: null, policy_oid: null, tsa_name: null, tsa_certificate_sha256: null, last_error: null, ...data } as unknown as Row;
      rows.push(row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    }),
  };
  return { prisma: { signTrustedTimestamp: table } as unknown as PrismaService, rows };
}

const T = '11111111-1111-4111-8111-111111111111';
const E = '22222222-2222-4222-8222-222222222222';
const D1 = '33333333-3333-4333-8333-333333333333';
const D2 = '44444444-4444-4444-8444-444444444444';
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);

function tokenFor(sha: string): TrustedTimestampToken {
  return {
    token_der: Buffer.from('3003020101', 'hex'),
    gen_time: new Date('2026-11-01T05:00:00.000Z'),
    serial_number: '2A',
    policy_oid: '1.2.3.4.1',
    hash_algorithm: 'SHA-256',
    message_imprint_sha256: sha,
    tsa_name: 'CN=Aramo Test TSA',
    tsa_certificate_sha256: 'c'.repeat(64),
  };
}

function stubTsa(behaviour: (sha: string) => Promise<TrustedTimestampToken>): TrustedTimestampPort & { calls: string[] } {
  const calls: string[] = [];
  return { tsa_url: 'https://tsa.test/rfc3161', calls, timestamp: async (sha) => { calls.push(sha); return behaviour(sha); } };
}

describe('TrustedTimestampService — off', () => {
  it('is a no-op without a TSA adapter (null binding = SIGN_TSA_URL unset or NOT_AVAILABLE)', async () => {
    const { prisma, rows } = fakePrisma();
    for (const svc of [new TrustedTimestampService(prisma), new TrustedTimestampService(prisma, null)]) {
      expect(svc.enabled).toBe(false);
      expect(await svc.stampExecutedDocuments(T, E, [{ envelope_document_id: D1, executed_sha256: H1 }])).toEqual([]);
      expect(await svc.stampEvidenceManifest(T, E, '{}')).toBeNull();
      expect(await svc.retryDue()).toBe(0);
    }
    expect(rows).toHaveLength(0);
  });
});

describe('TrustedTimestampService — on', () => {
  it('grants a verified token per executed document, in document order', async () => {
    const { prisma, rows } = fakePrisma();
    const tsa = stubTsa(async (sha) => tokenFor(sha));
    const svc = new TrustedTimestampService(prisma, tsa);
    const views = await svc.stampExecutedDocuments(T, E, [
      { envelope_document_id: D1, executed_sha256: H1 },
      { envelope_document_id: D2, executed_sha256: H2 },
    ]);
    expect(views.map((v) => [v.envelope_document_id, v.status, v.gen_time])).toEqual([
      [D1, 'GRANTED', '2026-11-01T05:00:00.000Z'],
      [D2, 'GRANTED', '2026-11-01T05:00:00.000Z'],
    ]);
    expect(views[0]?.token_der_base64).toBe(Buffer.from('3003020101', 'hex').toString('base64'));
    expect(rows.every((r) => r['tsa_url'] === 'https://tsa.test/rfc3161' && r['attempt_count'] === 1)).toBe(true);
    // Idempotent: a second call for the same documents makes no TSA request.
    await svc.stampExecutedDocuments(T, E, [{ envelope_document_id: D1, executed_sha256: H1 }]);
    expect(tsa.calls).toHaveLength(2);
    expect(rows).toHaveLength(2);
  });

  it('never throws on a TSA failure: records "timestamp pending" with the first backoff', async () => {
    const { prisma, rows } = fakePrisma();
    const svc = new TrustedTimestampService(prisma, stubTsa(async () => { throw new Error('TSA responded HTTP 503'); }));
    const before = Date.now();
    const views = await svc.stampExecutedDocuments(T, E, [{ envelope_document_id: D1, executed_sha256: H1 }]);
    expect(views.map((v) => v.status)).toEqual(['PENDING']);
    expect(rows[0]?.attempt_count).toBe(1);
    expect(rows[0]?.['last_error']).toBe('TSA responded HTTP 503');
    const next = (rows[0]?.next_attempt_at as Date).getTime();
    expect(next).toBeGreaterThanOrEqual(before + 30_000);
    expect(next).toBeLessThan(before + 31_000 + 5_000);
  });

  it('refuses a token whose imprint is not the subject (stays pending)', async () => {
    const { prisma } = fakePrisma();
    const svc = new TrustedTimestampService(prisma, stubTsa(async () => tokenFor(H2)));
    const views = await svc.stampExecutedDocuments(T, E, [{ envelope_document_id: D1, executed_sha256: H1 }]);
    expect(views[0]?.status).toBe('PENDING');
  });

  it('retries a pending timestamp only once its backoff has elapsed, then grants it', async () => {
    const { prisma, rows } = fakePrisma();
    let up = false;
    const tsa = stubTsa(async (sha) => {
      if (!up) throw new Error('timeout');
      return tokenFor(sha);
    });
    const svc = new TrustedTimestampService(prisma, tsa);
    await svc.stampExecutedDocuments(T, E, [{ envelope_document_id: D1, executed_sha256: H1 }]);
    up = true;
    expect(await svc.retryDue(new Date())).toBe(0); // backoff not elapsed
    expect(tsa.calls).toHaveLength(1);
    expect(await svc.retryDue(new Date(Date.now() + 60_000))).toBe(1);
    expect(rows[0]?.status).toBe('GRANTED');
    expect(rows[0]?.attempt_count).toBe(2);
    expect(rows[0]?.next_attempt_at).toBeNull();
    expect(await svc.retryDue(new Date(Date.now() + 120_000))).toBe(0); // nothing left
  });

  it('time-stamps the evidence manifest over its canonical JSON and keeps that JSON', async () => {
    const { prisma, rows } = fakePrisma();
    const tsa = stubTsa(async (sha) => tokenFor(sha));
    const svc = new TrustedTimestampService(prisma, tsa);
    const canonical = JSON.stringify({ envelope_id: E, executed_sha256: H1 });
    const view = await svc.stampEvidenceManifest(T, E, canonical);
    const sha = createHash('sha256').update(canonical, 'utf8').digest('hex');
    expect(view?.subject_kind).toBe('EVIDENCE_MANIFEST');
    expect(view?.message_imprint_sha256).toBe(sha);
    expect(view?.subject_canonical).toBe(canonical);
    expect(tsa.calls).toEqual([sha]);
    expect(rows[0]?.['envelope_document_id']).toBeNull();
    // The first recorded manifest wins.
    await svc.stampEvidenceManifest(T, E, JSON.stringify({ later: true }));
    expect(rows).toHaveLength(1);
  });

  it('lists documents first in the given order, then the manifest', async () => {
    const { prisma } = fakePrisma();
    const svc = new TrustedTimestampService(prisma, stubTsa(async (sha) => tokenFor(sha)));
    await svc.stampEvidenceManifest(T, E, '{"m":1}');
    await svc.stampExecutedDocuments(T, E, [{ envelope_document_id: D2, executed_sha256: H2 }]);
    await svc.stampExecutedDocuments(T, E, [{ envelope_document_id: D1, executed_sha256: H1 }]);
    const list = await svc.listForEnvelope(T, E, [D1, D2]);
    expect(list.map((v) => v.envelope_document_id ?? v.subject_kind)).toEqual([D1, D2, 'EVIDENCE_MANIFEST']);
  });
});

describe('certificate section', () => {
  it('prints genTime and TSA for a granted document and "pending" otherwise', () => {
    const blocks = trustedTimestampBlocks(
      [{ envelope_document_id: D1 }, { envelope_document_id: D2 }],
      [
        {
          subject_kind: 'EXECUTED_DOCUMENT', envelope_document_id: D1, message_imprint_sha256: H1, hash_algorithm: 'SHA-256', status: 'GRANTED',
          gen_time: '2026-11-01T05:00:00.000Z', tsa_name: 'CN=Aramo Test TSA', tsa_url: 'https://tsa.test', serial_number: '2A', policy_oid: '1.2.3.4.1',
          tsa_certificate_sha256: null, token_der_base64: 'MAM=', subject_canonical: null,
        },
      ],
    );
    const texts = blocks.map((b) => (b as { text: string }).text);
    expect(texts[0]).toBe('Trusted timestamps (RFC 3161)');
    expect(texts[1]).toBe(`Doc ${D1}: 2026-11-01T05:00:00.000Z by CN=Aramo Test TSA (serial 2A)`);
    expect(texts[2]).toMatch(new RegExp(`^Doc ${D2}: timestamp pending`));
    expect(texts[3]).toMatch(/evidence manifest is time-stamped after this certificate/);
  });
});
