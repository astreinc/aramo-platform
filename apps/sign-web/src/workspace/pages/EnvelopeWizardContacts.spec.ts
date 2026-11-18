import { describe, expect, it } from 'vitest';

import type { ContactRow } from '../api';

import { filterContactRows } from './EnvelopeWizard';

// UAT (contacts) — every saved contact is reachable when adding recipients on the web.
const row = (i: number): ContactRow => ({ name: `Person ${i}`, email: `p${i}@example.com`, envelope_count: 1, last_used_at: '2026-11-18T00:00:00Z' });

describe('From contacts', () => {
  it('lists every contact (no cap at eight)', () => {
    const all = Array.from({ length: 12 }, (_, i) => row(i + 1));
    expect(filterContactRows(all, '')).toHaveLength(12);
  });

  it('searches name or email, case-insensitive', () => {
    const all = [row(1), row(2), { ...row(3), name: 'Dana Lee', email: 'dana@northwind.example' }];
    expect(filterContactRows(all, 'dana').map((c) => c.email)).toEqual(['dana@northwind.example']);
    expect(filterContactRows(all, 'NORTHWIND')).toHaveLength(1);
    expect(filterContactRows(all, 'p2@')).toEqual([row(2)]);
    expect(filterContactRows(all, '  ')).toHaveLength(3);
  });
});
