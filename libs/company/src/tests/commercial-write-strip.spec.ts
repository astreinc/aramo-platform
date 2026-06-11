import { describe, expect, it } from 'vitest';

import {
  COMPANY_COMMERCIAL_WRITE_KEYS,
  stripUnscopedCommercialFields,
} from '../lib/commercial-write-strip.js';

// Company-Fields v1.1 — §4 LOAD-BEARING gate 2 (commercial-write-strip).
// A non-holder's payload has the commercial fields REMOVED before persist;
// because the repository writes present-keys-only, a stripped (now-absent)
// field is never set — so an existing commercial value is never nulled.

const COMMERCIAL_SCOPE = 'company:read_commercial';

function payloadWithCommercial(): Record<string, unknown> {
  return {
    name: 'Acme',
    industry: 'staffing',
    // commercial fields a malicious/over-eager non-holder might submit
    fee_model: 'contract',
    default_contract_markup_pct: '99.99',
    default_perm_fee_pct: '50.00',
    payment_terms: 'net_7',
    credit_status: 'hacked',
    default_currency: 'EUR',
  };
}

describe('stripUnscopedCommercialFields — commercial-write-strip', () => {
  it('STRIPS all 6 commercial keys for a non-holder; un-gated keys survive', () => {
    const stripped = stripUnscopedCommercialFields(payloadWithCommercial(), []);
    for (const key of COMPANY_COMMERCIAL_WRITE_KEYS) {
      expect(key in (stripped as Record<string, unknown>)).toBe(false);
    }
    // un-gated payload survives → the rest of the edit still saves.
    expect((stripped as Record<string, unknown>)['name']).toBe('Acme');
    expect((stripped as Record<string, unknown>)['industry']).toBe('staffing');
  });

  it('passes the payload through UNCHANGED for a holder', () => {
    const input = payloadWithCommercial();
    const out = stripUnscopedCommercialFields(input, [COMMERCIAL_SCOPE]);
    expect(out).toBe(input); // same reference — no clone for holders
    expect((out as Record<string, unknown>)['default_contract_markup_pct']).toBe(
      '99.99',
    );
  });

  it('strip is non-destructive to the original input object (shallow clone)', () => {
    const input = payloadWithCommercial();
    stripUnscopedCommercialFields(input, []);
    expect('fee_model' in input).toBe(true); // original untouched
  });

  it('strip leaves an absent commercial field absent (no null injected → no clear-on-update)', () => {
    // A non-holder PATCH that does NOT mention commercial fields: nothing to
    // strip, and crucially no commercial key is ADDED (so the repo never
    // writes/nulls them).
    const patch = { name: 'Renamed' };
    const stripped = stripUnscopedCommercialFields(patch, []) as Record<
      string,
      unknown
    >;
    for (const key of COMPANY_COMMERCIAL_WRITE_KEYS) {
      expect(key in stripped).toBe(false);
    }
    expect(stripped['name']).toBe('Renamed');
  });
});
