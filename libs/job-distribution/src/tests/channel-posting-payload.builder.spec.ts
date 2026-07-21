import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';
import {
  COMPENSATION_FIELD_KEYS,
  REQUISITION_FINANCIAL_FIELD_KEYS,
} from '@aramo/field-masking';

import {
  buildChannelPostingPayload,
  channelPostingContentHash,
} from '../lib/channel-posting-payload.builder.js';
import type { ChannelPostingInput } from '../lib/channel-posting.types.js';

// SRC-2 PR-2 (R3) — the negative specs are the point of this PR. The type-level
// half (@ts-expect-error per gated key) lives in the BUILT source guard
// channel-posting.gated-key-guard.ts (this repo does not type-check specs). Here:
//   (b) runtime — a fixture carrying EVERY gated key → builder output has none.
//   (c) import-boundary — the builder module references no projectView / masking
//       map / requisition repository.
// Plus positive builder + content-hash coverage.

const GATED_KEYS: readonly string[] = [
  ...COMPENSATION_FIELD_KEYS,
  ...REQUISITION_FINANCIAL_FIELD_KEYS,
];

function validInput(): ChannelPostingInput {
  return {
    requisition_id: '11111111-1111-7111-8111-111111111111',
    tenant_id: '22222222-2222-7222-8222-222222222222',
    title: 'Senior TypeScript Engineer',
    description: 'Build things.',
    city: 'Austin',
    state_code: 'TX',
    country: 'US',
    job_type: 'contract',
    work_arrangement: 'remote',
    openings: 2,
    advertised_pay_min: '80.00',
    advertised_pay_max: '120.00',
    advertised_pay_period: 'HOURLY',
    advertised_pay_currency: 'USD',
    public_listing: true,
    posted_at: '2026-07-21T00:00:00.000Z',
    updated_at: '2026-07-21T00:00:00.000Z',
  };
}

function collectKeys(value: unknown, acc: Set<string>): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, acc);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    acc.add(k);
    collectKeys(v, acc);
  }
}

describe('buildChannelPostingPayload — R3 negative (runtime)', () => {
  it('emits ZERO gated compensation-map / financials-map keys even when the input carries every one', () => {
    // Force every gated key onto the input (bypassing the allowlist type — the
    // type-level guard proves this cannot happen through the type). The builder
    // reads only the allowlist, so its output must contain none of them.
    const contaminated = { ...validInput() } as Record<string, unknown>;
    for (const k of GATED_KEYS) contaminated[k] = 'LEAK';

    const payload = buildChannelPostingPayload(
      contaminated as unknown as ChannelPostingInput,
    );

    const keys = new Set<string>();
    collectKeys(payload, keys);

    const leaked = GATED_KEYS.filter((k) => keys.has(k));
    expect(leaked).toEqual([]);
    // And the sentinel value never appears anywhere in the serialization.
    expect(JSON.stringify(payload)).not.toContain('LEAK');
  });

  it('confirms the gated-key set under test is non-empty (13 comp + 7 financials)', () => {
    expect(COMPENSATION_FIELD_KEYS.length).toBe(13);
    expect(REQUISITION_FINANCIAL_FIELD_KEYS.length).toBe(7);
  });
});

describe('buildChannelPostingPayload — R3 negative (import-boundary)', () => {
  it('the builder module source references no projectView / masking map / requisition repository', () => {
    const src = readFileSync(
      resolve(__dirname, '../lib/channel-posting-payload.builder.ts'),
      'utf8',
    );
    // Strip line + block comments so the prose explanation of WHY it avoids these
    // does not trip the scan; assert on code only.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('projectView');
    expect(code).not.toMatch(/field-masking|compensation-field-map|financials-field-map/);
    expect(code).not.toContain('@aramo/requisition');
    expect(code).not.toMatch(/requisition\.repository/);
    // The only imports are node:crypto + the local types.
    const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./channel-posting.types.js', 'node:crypto']);
  });
});

describe('buildChannelPostingPayload — positive shape + content hash', () => {
  it('maps the allowlist input to the channel-agnostic payload', () => {
    const payload = buildChannelPostingPayload(validInput());
    expect(payload.external_requisition_ref).toBe('11111111-1111-7111-8111-111111111111');
    expect(payload.title).toBe('Senior TypeScript Engineer');
    expect(payload.location).toEqual({ city: 'Austin', state_code: 'TX', country: 'US' });
    expect(payload.advertised_compensation).toEqual({
      min: '80.00',
      max: '120.00',
      period: 'HOURLY',
      currency: 'USD',
    });
    expect(payload.public_listing).toBe(true);
  });

  it('content hash is stable for equal payloads and changes when a value changes', () => {
    const a = channelPostingContentHash(buildChannelPostingPayload(validInput()));
    const b = channelPostingContentHash(buildChannelPostingPayload(validInput()));
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);

    const changed = channelPostingContentHash(
      buildChannelPostingPayload({ ...validInput(), advertised_pay_max: '130.00' }),
    );
    expect(changed).not.toBe(a);
  });
});
