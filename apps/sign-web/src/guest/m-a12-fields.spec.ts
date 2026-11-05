import { describe, expect, it } from 'vitest';

import { today } from './App';
import { DEFAULT_SIZE, fieldBox } from './field-geometry';

// Aramo-Sign-Mobile-Amendment-M-A12 (LOCKED) W1-C.4 / W1-E.2 — the signer page renders the
// profile text fields like text fields, and dates in the sender's stamped format.

describe('M-A12 — signer rendering', () => {
  it('SIGN_DATE uses the stamped format; an envelope without one keeps YYYY-MM-DD', () => {
    const d = new Date(2026, 10, 4, 12, 0, 0);
    expect(today('MM/DD/YYYY', d)).toBe('11/04/2026');
    expect(today('DD/MM/YYYY', d)).toBe('04/11/2026');
    expect(today('YYYY-MM-DD', d)).toBe('2026-11-04');
    expect(today(null, d)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the profile text fields have a default box and lay out on the page', () => {
    for (const t of ['FIRST_NAME', 'LAST_NAME', 'EMAIL', 'COMPANY', 'TITLE']) {
      expect(DEFAULT_SIZE[t]).toBeDefined();
      const box = fieldBox({ field_type: t, x: 60, y: 700, width: null, height: null }, { width: 600, height: 800 });
      expect(box.left).toBe('10%');
    }
  });
});
