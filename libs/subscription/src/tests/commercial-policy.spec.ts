import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  COMMERCIAL_POLICY_KEYS,
  CommercialPolicyUnavailableError,
  canonicalJson,
  commercialPolicyChecksum,
  parseActiveCommercialPolicy,
  parseCommercialPolicyContent,
} from '../lib/commercial/commercial-policy.js';

import { CCP_A2_MIGRATION, seededPolicyV1 } from './fixtures/commercial-policy-seed.js';

// CCP-A2 (PBD §5.1 row A2; Charter §7 / D5) — the v1 seed equals the PO-mandated values,
// its checksum equals a recomputation, and the strict parser fails closed on a missing,
// non-ACTIVE, malformed or tampered policy.

// Charter §7 (D5), restated here ONLY as the expected test oracle, in the document's units.
const D5_EXPECTED = {
  format_version: 1,
  currency: 'USD',
  discount_escalation_threshold_bps: 2000, // 20%
  credit_escalation_threshold_minor: 50000, // $500.00
  support_extension_max_days: 14,
  support_extension_frequency_window_days: 90,
  support_extension_cumulative_max_days: 30,
  support_extension_cumulative_window_days: 365, // rolling 12 months (PO 2026-10-24)
  approval_expiry_hours: 72,
  past_due_grace_days: 7,
};
const V1_CHECKSUM = 'bdc36ef2f1cde82945139efffdac03c999d98a026113b4dde6e13f0ce05752f5';

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof CommercialPolicyUnavailableError) return e.reason;
    throw e;
  }
  return undefined;
}

describe('CCP-A2 commercial policy v1 seed', () => {
  it('the seeded document equals the Charter §7 (D5) values exactly', () => {
    const { content } = seededPolicyV1();
    expect(content).toEqual(D5_EXPECTED);
    expect(parseCommercialPolicyContent(content)).toEqual(D5_EXPECTED);
  });

  it('the seeded checksum equals the SHA-256 recomputed over the canonical JSON', () => {
    const { content, checksum } = seededPolicyV1();
    expect(checksum).toBe(V1_CHECKSUM);
    expect(commercialPolicyChecksum(content)).toBe(checksum);
    // The two audit seed rows carry the same checksum.
    const sql = readFileSync(CCP_A2_MIGRATION, 'utf8');
    expect(sql.split(V1_CHECKSUM).length - 1).toBe(3);
  });

  it('the seed is idempotent (fixed ids, ON CONFLICT DO NOTHING) and seeds exactly one ACTIVE row', () => {
    const sql = readFileSync(CCP_A2_MIGRATION, 'utf8');
    expect(sql.match(/ON CONFLICT \("id"\) DO NOTHING/g)?.length).toBe(3);
    expect(sql.match(/^\s+'ACTIVE',$/gm)?.length).toBe(1);
  });

  it('the canonical JSON is key-order independent', () => {
    const a = { b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } };
    const b = { a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
    expect(commercialPolicyChecksum({ ...D5_EXPECTED })).toBe(V1_CHECKSUM);
    const reversed = Object.fromEntries(Object.entries(D5_EXPECTED).reverse());
    expect(commercialPolicyChecksum(reversed)).toBe(V1_CHECKSUM);
  });

  it('the policy module holds no policy value (none of the D5 numbers appears in its source)', () => {
    for (const f of ['commercial-policy.ts', 'commercial-policy-boundaries.ts', 'commercial-policy.repository.ts']) {
      const src = readFileSync(new URL(`../lib/commercial/${f}`, import.meta.url), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/**'))
        .join('\n');
      for (const n of [2000, 50000, 14, 90, 30, 365, 72, 7]) {
        expect(new RegExp(`(?<![\\w.])${n}(?![\\w])`).test(src), `${f} contains the literal ${n}`).toBe(false);
      }
    }
  });
});

describe('CCP-A2 strict parser (fail closed)', () => {
  const good = (): Record<string, unknown> => ({ ...D5_EXPECTED });

  it('accepts exactly the format-1 key set', () => {
    expect(Object.keys(good()).sort()).toEqual([...COMMERCIAL_POLICY_KEYS].sort());
  });

  const malformed: Array<[string, (d: Record<string, unknown>) => unknown]> = [
    ['not an object (null)', () => null],
    ['not an object (array)', () => []],
    ['not an object (string)', () => 'policy'],
    ['missing key', (d) => { delete d['approval_expiry_hours']; return d; }],
    ['unknown key', (d) => ({ ...d, discount_escalation_threshold_pct: 20 })],
    ['format_version 2', (d) => ({ ...d, format_version: 2 })],
    ['currency lower-case', (d) => ({ ...d, currency: 'usd' })],
    ['currency missing code', (d) => ({ ...d, currency: '' })],
    ['threshold as a string', (d) => ({ ...d, discount_escalation_threshold_bps: '2000' })],
    ['threshold fractional', (d) => ({ ...d, discount_escalation_threshold_bps: 1999.5 })],
    ['threshold zero', (d) => ({ ...d, discount_escalation_threshold_bps: 0 })],
    ['discount over 100%', (d) => ({ ...d, discount_escalation_threshold_bps: 10001 })],
    ['credit negative', (d) => ({ ...d, credit_escalation_threshold_minor: -1 })],
    ['extension days zero', (d) => ({ ...d, support_extension_max_days: 0 })],
    ['expiry null', (d) => ({ ...d, approval_expiry_hours: null })],
    ['grace negative', (d) => ({ ...d, past_due_grace_days: -1 })],
    ['grace NaN', (d) => ({ ...d, past_due_grace_days: Number.NaN })],
    ['max extension above the cumulative cap', (d) => ({ ...d, support_extension_max_days: 31 })],
    ['cumulative window shorter than the frequency window', (d) => ({ ...d, support_extension_cumulative_window_days: 89 })],
  ];
  for (const [name, mutate] of malformed) {
    it(`refuses MALFORMED — ${name}`, () => {
      expect(reasonOf(() => parseCommercialPolicyContent(mutate(good())))).toBe('MALFORMED');
    });
  }

  it('grace of 0 days is structurally valid (a policy may set no grace)', () => {
    expect(parseCommercialPolicyContent({ ...good(), past_due_grace_days: 0 }).past_due_grace_days).toBe(0);
  });

  const row = (over: Partial<{ status: string; content: unknown; content_checksum: string }> = {}) => ({
    id: '019a0000-0000-7000-8000-0000000cc201',
    version_number: 1,
    status: 'ACTIVE',
    content: good(),
    content_checksum: V1_CHECKSUM,
    ...over,
  });

  it('parses the ACTIVE v1 row', () => {
    const p = parseActiveCommercialPolicy(row());
    expect(p).toEqual({ version_id: '019a0000-0000-7000-8000-0000000cc201', version_number: 1, checksum: V1_CHECKSUM, content: D5_EXPECTED });
  });
  it('refuses MISSING (null and undefined)', () => {
    expect(reasonOf(() => parseActiveCommercialPolicy(null))).toBe('MISSING');
    expect(reasonOf(() => parseActiveCommercialPolicy(undefined))).toBe('MISSING');
  });
  it('refuses NOT_ACTIVE (DRAFT, RETIRED)', () => {
    expect(reasonOf(() => parseActiveCommercialPolicy(row({ status: 'DRAFT' })))).toBe('NOT_ACTIVE');
    expect(reasonOf(() => parseActiveCommercialPolicy(row({ status: 'RETIRED' })))).toBe('NOT_ACTIVE');
  });
  it('refuses MALFORMED content on an ACTIVE row', () => {
    expect(reasonOf(() => parseActiveCommercialPolicy(row({ content: { ...good(), extra: 1 } })))).toBe('MALFORMED');
  });
  it('refuses CHECKSUM_MISMATCH (content changed, checksum not; and a wrong checksum)', () => {
    expect(reasonOf(() => parseActiveCommercialPolicy(row({ content: { ...good(), approval_expiry_hours: 96 } })))).toBe('CHECKSUM_MISMATCH');
    expect(reasonOf(() => parseActiveCommercialPolicy(row({ content_checksum: '0'.repeat(64) })))).toBe('CHECKSUM_MISMATCH');
  });
});
