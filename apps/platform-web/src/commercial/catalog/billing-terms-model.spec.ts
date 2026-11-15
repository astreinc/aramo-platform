import { describe, expect, it } from 'vitest';

import { channelTermsNote } from './billing-products-model';
import type { CatalogVersionTerms } from './catalog-api';
import {
  ANNUAL_TERM_LABEL,
  annualSavingPercent,
  annualTermOf,
  billingTermsLine,
  draftDiff,
  editorOf,
  parseFieldInput,
  priceText,
} from './catalog-model';
import { ENTERPRISE, TEAM, TERMS, v } from './catalog-test-data';

// Sign Monthly and Annual-Commitment Pricing v1.0 — the console's two billing terms (Monthly; optional
// Annual: 12-month commitment, billed monthly at its own price).

const TWO_TERMS: CatalogVersionTerms = {
  ...TERMS,
  list_price_minor: 1500,
  explicit_terms: true,
  billing_terms: [
    { term: 'MONTHLY', list_price_minor: 1500, commitment_months: null },
    { term: 'ANNUAL_COMMIT', list_price_minor: 1200, commitment_months: 12 },
  ],
};
const LEGACY_COMMIT: CatalogVersionTerms = { ...TERMS, list_price_minor: 1000, explicit_terms: false, billing_terms: [{ term: 'ANNUAL_COMMIT', list_price_minor: 1000, commitment_months: 12 }] };

describe('billing terms — console model', () => {
  it('the annual term is read only from explicit terms (a legacy commitment is not an annual option)', () => {
    expect(annualTermOf(TWO_TERMS)?.list_price_minor).toBe(1200);
    expect(annualTermOf(LEGACY_COMMIT)).toBeNull();
    expect(annualTermOf(TERMS)).toBeNull();
  });

  it('the saving is whole percent rounded down, only when the annual price is lower', () => {
    expect(annualSavingPercent(1500, 1200)).toBe(20);
    expect(annualSavingPercent(1000, 999)).toBe(0);
    expect(annualSavingPercent(1000, 1000)).toBeNull();
    expect(annualSavingPercent(1000, 1100)).toBeNull();
    expect(annualSavingPercent(null, 1100)).toBeNull();
  });

  it('the terms line shows both prices, the commitment and the saving', () => {
    expect(billingTermsLine(TWO_TERMS)).toBe('Monthly $15 / mo (no commitment) · Annual $12 / mo (12-month commitment, saves 20%)');
    expect(billingTermsLine(LEGACY_COMMIT)).toBe('$10 / mo (12-month commitment)');
    expect(billingTermsLine(TERMS)).toBe('$59 / mo');
    expect(billingTermsLine({ ...TERMS, explicit_terms: true, billing_terms: [{ term: 'MONTHLY', list_price_minor: 5900, commitment_months: null }] })).toBe('$59 / mo (no commitment)');
    expect(billingTermsLine(ENTERPRISE.versions[0]!.terms)).toBe('Contract only');
    expect(priceText(TWO_TERMS)).toBe('$15 / mo · Annual $12 / mo');
  });

  it('the annual field: editable on a self-service DRAFT, read-only when published or contract-priced', () => {
    const draft = v({ id: 'd', version_number: 4, status: 'DRAFT', terms: TWO_TERMS });
    const f = editorOf(TEAM, draft, true).fields.find((x) => x.key === 'annual');
    expect(f).toMatchObject({ label: ANNUAL_TERM_LABEL, value: '12', readOnly: false, placeholder: 'Monthly only' });
    expect(f?.hint).toContain('12-month commitment');
    const pub = v({ id: 'p', version_number: 4, status: 'PUBLISHED', terms: TWO_TERMS });
    expect(editorOf(TEAM, pub, true).fields.find((x) => x.key === 'annual')?.readOnly).toBe(true);
    const entDraft = { ...ENTERPRISE.versions[0]!, status: 'DRAFT' as const };
    expect(editorOf(ENTERPRISE, entDraft, true).fields.find((x) => x.key === 'annual')?.readOnly).toBe(true);
  });

  it('the annual input: "" removes the option (null); otherwise 1 cent to $1,000,000', () => {
    expect(parseFieldInput('annual', '')).toEqual({ ok: true, value: null });
    expect(parseFieldInput('annual', '12')).toEqual({ ok: true, value: 1200 });
    expect(parseFieldInput('annual', '12.5')).toEqual({ ok: true, value: 1250 });
    expect(parseFieldInput('annual', '0')).toEqual({ ok: false });
    expect(parseFieldInput('annual', '-1')).toEqual({ ok: false });
    expect(parseFieldInput('annual', '1000001')).toEqual({ ok: false });
  });

  it('the draft diff gains an Annual row only when either side offers it', () => {
    const rows = draftDiff(TERMS, TWO_TERMS, 'editor');
    expect(rows.find((r) => r.field === 'Annual (12-month commitment)')).toEqual({ field: 'Annual (12-month commitment)', before: 'Not offered', after: '$12 / mo', changed: true });
    expect(draftDiff(TERMS, TERMS, 'editor').some((r) => r.field.startsWith('Annual'))).toBe(false);
  });

  it('channel notes: Stripe sells every term; the stores and Razorpay the Monthly term only', () => {
    expect(channelTermsNote('STRIPE')).toContain('every term');
    for (const p of ['APP_STORE', 'GOOGLE_PLAY', 'RAZORPAY'] as const) expect(channelTermsNote(p)).toBe('Sells the Monthly term only');
  });
});
