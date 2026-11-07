// M-A14 R-4 — the paper card's numbers: parsed defensively and pluralised.
import { documentsLabel, parseSigningStats, sheetsLabel } from '../signingStats';

describe('signing stats', () => {
  it('pluralises documents and sheets', () => {
    expect(documentsLabel(0)).toBe('0 documents');
    expect(documentsLabel(1)).toBe('1 document');
    expect(documentsLabel(2)).toBe('2 documents');
    expect(sheetsLabel(0)).toBe('0 sheets');
    expect(sheetsLabel(1)).toBe('1 sheet');
    expect(sheetsLabel(3)).toBe('3 sheets');
  });

  it('accepts only two non-negative whole numbers', () => {
    expect(parseSigningStats({ documents_signed: 1, pages_signed: 3 })).toEqual({
      documentsSigned: 1,
      pagesSigned: 3,
    });
    expect(parseSigningStats({ documents_signed: 0, pages_signed: 0 })).toEqual({
      documentsSigned: 0,
      pagesSigned: 0,
    });
    expect(parseSigningStats(null)).toBeNull();
    expect(parseSigningStats({})).toBeNull();
    expect(parseSigningStats({ documents_signed: '1', pages_signed: 3 })).toBeNull();
    expect(parseSigningStats({ documents_signed: -1, pages_signed: 3 })).toBeNull();
    expect(parseSigningStats({ documents_signed: 1.5, pages_signed: 3 })).toBeNull();
  });
});
