import { describe, expect, it } from 'vitest';

import { INDIA_STATE_CODES, parseEstampRequest } from '../lib/regulated/estamp-workflow.service.js';
import { RegulatedSigningValidationError } from '../lib/regulated/regulated-errors.js';

// Feature-Parity §1.19 (Amendment A1) — validation of the sender's e-stamp request.
const VALID = {
  state_code: 'in-ka',
  article_code: ' Article 5(J) — Agreement ',
  stamp_duty_amount_paise: 20000,
  consideration_amount_paise: 0,
  first_party: 'Acme Pvt Ltd',
  second_party: 'Ravi Kumar',
  purchaser: 'Acme Pvt Ltd',
};

function reason(body: Record<string, unknown>): string {
  try {
    parseEstampRequest(body);
  } catch (e) {
    if (e instanceof RegulatedSigningValidationError) return e.field;
    throw e;
  }
  return 'ok';
}

describe('parseEstampRequest', () => {
  it('normalizes a valid request', () => {
    expect(parseEstampRequest(VALID)).toEqual({
      state_code: 'IN-KA',
      article_code: 'Article 5(J) — Agreement',
      stamp_duty_amount_paise: 20000,
      consideration_amount_paise: 0,
      first_party: 'Acme Pvt Ltd',
      second_party: 'Ravi Kumar',
      purchaser: 'Acme Pvt Ltd',
      description: null,
    });
  });
  it('accepts the 2023-renamed state codes in both forms', () => {
    for (const c of ['IN-OR', 'IN-OD', 'IN-TG', 'IN-TS', 'IN-UT', 'IN-UK', 'IN-CT', 'IN-CG']) expect(INDIA_STATE_CODES.has(c)).toBe(true);
  });
  it('refuses an unknown or non-Indian state code', () => {
    expect(reason({ ...VALID, state_code: 'IN-ZZ' })).toBe('state_code');
    expect(reason({ ...VALID, state_code: 'US-CA' })).toBe('state_code');
    expect(reason({ ...VALID, state_code: undefined })).toBe('state_code');
  });
  it('requires a positive whole number of paise for the duty', () => {
    expect(reason({ ...VALID, stamp_duty_amount_paise: 0 })).toBe('stamp_duty_amount_paise');
    expect(reason({ ...VALID, stamp_duty_amount_paise: 10.5 })).toBe('stamp_duty_amount_paise');
    expect(reason({ ...VALID, stamp_duty_amount_paise: '100' })).toBe('stamp_duty_amount_paise');
    expect(reason({ ...VALID, consideration_amount_paise: -1 })).toBe('consideration_amount_paise');
  });
  it('requires the parties and the article, within their lengths', () => {
    expect(reason({ ...VALID, first_party: '  ' })).toBe('first_party');
    expect(reason({ ...VALID, second_party: undefined })).toBe('second_party');
    expect(reason({ ...VALID, purchaser: 'x'.repeat(201) })).toBe('purchaser');
    expect(reason({ ...VALID, article_code: 42 })).toBe('article_code');
    expect(reason({ ...VALID, description: 'x'.repeat(501) })).toBe('description');
  });
  it('treats an empty body as missing fields', () => {
    expect(() => parseEstampRequest(undefined)).toThrow(RegulatedSigningValidationError);
  });
});
