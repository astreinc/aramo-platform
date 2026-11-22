import { signDatePreview } from '@aramo/sign-client';
import { describe, expect, it } from 'vitest';

import { DEFAULT_SIZE, fieldBox } from './field-geometry';

// Aramo-Sign-Mobile-Amendment-M-A12 (LOCKED) W1-C.4 / W1-E.2 — the signer page renders the
// profile text fields like text fields, and dates in the sender's stamped format.

describe('M-A12 — signer rendering', () => {
  it('SIGN_DATE previews the stamped format; an envelope without one previews MM/DD/YYYY', () => {
    const d = new Date(2026, 10, 4, 12, 0, 0);
    expect(signDatePreview('MM/DD/YYYY', d)).toBe('11/04/2026');
    expect(signDatePreview('DD/MM/YYYY', d)).toBe('04/11/2026');
    expect(signDatePreview('YYYY-MM-DD', d)).toBe('2026-11-04');
    // C0-2 — no stamped format previews the server's default (MM/DD/YYYY).
    expect(signDatePreview(null, d)).toBe('11/04/2026');
  });

  it('the profile text fields have a default box and lay out on the page', () => {
    for (const t of ['FIRST_NAME', 'LAST_NAME', 'EMAIL', 'COMPANY', 'TITLE']) {
      expect(DEFAULT_SIZE[t]).toBeDefined();
      const box = fieldBox({ field_type: t, x: 60, y: 700, width: null, height: null }, { width: 600, height: 800 });
      expect(box.left).toBe('10%');
    }
  });

  it('FIELD-PARITY-1 P3 — the new types take the catalog’s default box', () => {
    const page = { width: 600, height: 800 };
    expect(fieldBox({ field_type: 'MULTILINE_TEXT', x: 0, y: 0, width: null, height: null }, page).height).toBe(`${(66 / 800) * 100}%`);
    expect(fieldBox({ field_type: 'RADIO', x: 0, y: 0, width: null, height: null }, page).width).toBe(`${(18 / 600) * 100}%`);
    for (const t of ['DATE', 'DROPDOWN', 'NUMBER']) expect(fieldBox({ field_type: t, x: 0, y: 0, width: null, height: null }, page).height).toBe(`${(22 / 800) * 100}%`);
  });
});
