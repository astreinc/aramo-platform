import { describe, expect, it } from 'vitest';

import { esignCopyLine } from './t360-documents';

// Retention and Purge directive (ebd41d99) W11 — the "Signed copy also held by Sign" line.

describe('esignCopyLine', () => {
  it('is absent when the document was not signed through Aramo Sign (or an older payload)', () => {
    expect(esignCopyLine(undefined)).toBeNull();
    expect(esignCopyLine(null)).toBeNull();
  });

  it('held, purge scheduled, purged', () => {
    expect(esignCopyLine({ status: 'held', at: null })).toBe('Yes');
    expect(esignCopyLine({ status: 'purge_scheduled', at: '2026-11-14T00:00:00Z' })).toMatch(/^Yes · purge scheduled \S/);
    expect(esignCopyLine({ status: 'purge_scheduled', at: null })).toBe('Yes · purge scheduled');
    expect(esignCopyLine({ status: 'purged', at: '2026-11-28T00:00:00Z' })).toMatch(/^No · purged on \S/);
    expect(esignCopyLine({ status: 'purged', at: null })).toBe('No · purged');
  });
});
