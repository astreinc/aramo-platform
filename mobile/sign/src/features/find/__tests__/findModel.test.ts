// M-A12 W1-C — Find in document (on-device search over the server's text layer) and
// page navigation. No document text is logged or stored; these are pure functions.
import type { TextLayer } from '../../../api/m-a12-contract-types';
import {
  FIND_COPY,
  findMatches,
  findStatus,
  hasText,
  pageHighlights,
  pageInView,
  pageLabel,
  stepMatch,
} from '../findModel';
import { parseTextLayer } from '../textLayerApi';

const w = (t: string, x: number, y = 0.1) => ({ t, x, y, w: 0.05, h: 0.01 });

const LAYER: TextLayer = {
  document_id: 'd1',
  pages: [
    { page: 1, words: [w('Employment', 0.1), w('Agreement', 0.2), w('date', 0.3)] },
    { page: 2, words: [w('The', 0.1, 0.5), w('agreement', 0.2, 0.5), w('ends', 0.3, 0.5)] },
  ],
};
const IMAGE_ONLY: TextLayer = { document_id: 'd2', pages: [{ page: 1, words: [] }] };

describe('findMatches', () => {
  it('finds every match in reading order, case- and accent-insensitive', () => {
    const m = findMatches([{ docKey: 'a', layer: LAYER }], 'AGREEMENT');
    expect(m.map((x) => [x.docKey, x.page])).toEqual([
      ['a', 0],
      ['a', 1],
    ]);
    expect(findMatches([{ docKey: 'a', layer: { document_id: 'x', pages: [{ page: 1, words: [w('Café', 0)] }] } }], 'cafe')).toHaveLength(1);
  });

  it('matches a phrase across consecutive words and returns one box per word', () => {
    const m = findMatches([{ docKey: 'a', layer: LAYER }], 'ment agreement da');
    expect(m).toHaveLength(1);
    expect(m[0]?.rects).toHaveLength(3);
  });

  it('needs at least 2 letters', () => {
    expect(findMatches([{ docKey: 'a', layer: LAYER }], 'a')).toEqual([]);
  });

  it('an image-only PDF has no searchable text', () => {
    expect(hasText([IMAGE_ONLY])).toBe(false);
    expect(hasText([IMAGE_ONLY, LAYER])).toBe(true);
    expect(findStatus({ query: 'agreement', matches: [], index: 0, searchable: false })).toBe(
      'No searchable text in this document',
    );
  });
});

describe('findStatus / stepMatch / pageHighlights', () => {
  const matches = findMatches([{ docKey: 'a', layer: LAYER }], 'agreement');
  it('says "n of m", too short, or no matches', () => {
    expect(findStatus({ query: 'agreement', matches, index: 1, searchable: true })).toBe('2 of 2');
    expect(findStatus({ query: 'a', matches: [], index: 0, searchable: true })).toBe(FIND_COPY.tooShort);
    expect(findStatus({ query: 'zebra', matches: [], index: 0, searchable: true })).toBe(FIND_COPY.none);
  });
  it('next / previous wrap around', () => {
    expect(stepMatch(1, 2, 1)).toBe(0);
    expect(stepMatch(0, 2, -1)).toBe(1);
    expect(stepMatch(0, 0, 1)).toBe(0);
  });
  it('highlights only the page asked for, marking the current match', () => {
    expect(pageHighlights(matches, 1, 'a', 1)).toEqual([{ rect: { x: 0.2, y: 0.5, w: 0.05, h: 0.01 }, current: true }]);
    expect(pageHighlights(matches, 1, 'a', 0)[0]?.current).toBe(false);
    expect(pageHighlights(matches, 0, 'b', 0)).toEqual([]);
  });
});

describe('page navigation', () => {
  it('"Page n of N", clamped', () => {
    expect(pageLabel(3, 7)).toBe('Page 3 of 7');
    expect(pageLabel(0, 0)).toBe('Page 1 of 1');
  });
  it('the page in view is the last one whose top is above a third of the viewport', () => {
    expect(pageInView([0, 800, 1600], 0, 600)).toBe(0);
    expect(pageInView([0, 800, 1600], 700, 600)).toBe(1);
    expect(pageInView([0, 800, 1600], 1500, 600)).toBe(2);
  });
});

describe('parseTextLayer', () => {
  it('keeps well-formed words only', () => {
    const l = parseTextLayer(
      { document_id: 'd1', pages: [{ page: 1, words: [w('ok', 0.1), { t: 3, x: 0 }, null] }, { page: 0, words: [] }] },
      'fallback',
    );
    expect(l).toEqual({ document_id: 'd1', pages: [{ page: 1, words: [w('ok', 0.1)] }] });
    expect(parseTextLayer(null, 'd9')).toEqual({ document_id: 'd9', pages: [] });
  });
});
