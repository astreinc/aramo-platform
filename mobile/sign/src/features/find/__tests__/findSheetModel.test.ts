// M-A14 — the Find in Document sheet lists matches by page with the words around them.
import { findListStatus, findMatches, matchSnippet } from '../findModel';

const words = (s: string) => s.split(' ').map((t, i) => ({ t, x: i / 20, y: 0.1, w: 0.04, h: 0.01 }));

describe('Find in Document (M-A14 a10)', () => {
  const layer = {
    document_id: 'd',
    pages: [
      { page: 1, words: words('This Lease Agreement is made between the Landlord and the Tenant named below') },
      { page: 2, words: words('The lease term is twelve months') },
    ],
  };

  it('says how many matches are highlighted, or why there are none', () => {
    const m = findMatches([{ docKey: 'd', layer }], 'lease');
    expect(m.map((x) => x.page)).toEqual([0, 1]);
    expect(findListStatus({ query: 'lease', matches: m, searchable: true })).toBe('2 matches · highlighted on the page');
    expect(findListStatus({ query: 'lease', matches: m.slice(0, 1), searchable: true })).toBe('1 match · highlighted on the page');
    expect(findListStatus({ query: 'l', matches: [], searchable: true })).toBe('Type at least 2 letters');
    expect(findListStatus({ query: 'zzz', matches: [], searchable: true })).toBe('No matches');
    expect(findListStatus({ query: 'zzz', matches: [], searchable: false })).toBe('No searchable text in this document');
  });

  it('the snippet: up to 26 characters before and 38 after, with ellipses', () => {
    const [first, second] = findMatches([{ docKey: 'd', layer }], 'lease');
    expect(first?.word).toBe(1);
    expect(matchSnippet(layer.pages[0]!.words, first!.word!, first!.count!)).toEqual({
      pre: 'This ',
      hit: 'Lease',
      post: ' Agreement is made between the Landlor…',
    });
    expect(matchSnippet(layer.pages[1]!.words, second!.word!, second!.count!)).toEqual({
      pre: 'The ',
      hit: 'lease',
      post: ' term is twelve months',
    });
    const long = words('one two three four five six seven eight nine ten target');
    expect(matchSnippet(long, 10, 1).pre).toBe('… six seven eight nine ten ');
  });
});
