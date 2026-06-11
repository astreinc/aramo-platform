import { describe, expect, it } from 'vitest';

import { normalizeNewTypedFields } from '../lib/company.repository.js';

// Company-Fields v1.1 — the create-failure fix. Empty-string for the new
// TYPED columns was reaching Prisma un-parseable ("Failed to parse empty
// string. Expected decimal" / "Expected Int" / "Expected String[]"). The
// repository boundary coerces them so a blank form field never 500s.

describe('normalizeNewTypedFields — blank/typed coercion at the write boundary', () => {
  it('coerces empty-string Decimal fields to null', () => {
    const out = normalizeNewTypedFields({
      default_contract_markup_pct: '',
      default_perm_fee_pct: '',
    }) as Record<string, unknown>;
    expect(out['default_contract_markup_pct']).toBeNull();
    expect(out['default_perm_fee_pct']).toBeNull();
  });

  it('coerces empty-string Int (founded_year) to null; numeric string → number', () => {
    expect(
      (normalizeNewTypedFields({ founded_year: '' }) as Record<string, unknown>)[
        'founded_year'
      ],
    ).toBeNull();
    expect(
      (normalizeNewTypedFields({ founded_year: '2020' }) as Record<string, unknown>)[
        'founded_year'
      ],
    ).toBe(2020);
    // non-numeric string → null (never an un-parseable Int)
    expect(
      (normalizeNewTypedFields({ founded_year: 'abc' }) as Record<string, unknown>)[
        'founded_year'
      ],
    ).toBeNull();
  });

  it('coerces empty-string DateTime rollups to null', () => {
    const out = normalizeNewTypedFields({
      last_activity_at: '',
      next_action_at: '',
    }) as Record<string, unknown>;
    expect(out['last_activity_at']).toBeNull();
    expect(out['next_action_at']).toBeNull();
  });

  it('drops a non-array tags value to undefined (never a bare string to a String[] column)', () => {
    const out = normalizeNewTypedFields({ tags: '' }) as Record<string, unknown>;
    expect(out['tags']).toBeUndefined();
  });

  it('leaves valid values untouched (numbers, arrays, decimal strings, String "")', () => {
    const out = normalizeNewTypedFields({
      default_contract_markup_pct: '25.00',
      founded_year: 2019,
      tags: ['a', 'b'],
      status: '', // String column — "" is a valid TEXT value, left as-is
    }) as Record<string, unknown>;
    expect(out['default_contract_markup_pct']).toBe('25.00');
    expect(out['founded_year']).toBe(2019);
    expect(out['tags']).toEqual(['a', 'b']);
    expect(out['status']).toBe('');
  });
});
