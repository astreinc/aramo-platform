// UAT SIG-16 retest (web ≡ app) — Find in the document, with the app's matching rules
// (mobile/sign/src/features/find/findModel.ts, M-A12 W1-C.2). The words and their boxes come
// from the server's text layer for this signing session (POST /v1/sign/signing/documents/
// {id}/text-layer, the route the app uses); the search and the highlight happen here. The
// text is held in memory for the open document only and never logged or stored.
//
// A query matches a run of consecutive words on one page, case- and accent-insensitive; a
// one-word query matches inside a word ("citizen" finds "citizen-facing"), and for several
// words the first may end with and the last may start with the query's edges.

export interface TextLayerWord {
  readonly t: string;
  /** Normalised to the page (0..1), origin top-left. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface TextLayer {
  readonly document_id: string;
  readonly pages: readonly { readonly page: number; readonly words: readonly TextLayerWord[] }[];
}

export const MIN_QUERY = 2;

export const FIND_COPY = {
  noText: 'No searchable text in this document',
  tooShort: 'Type at least 2 letters',
  none: 'No matches',
  loading: 'Reading the document…',
  failed: 'Couldn’t search this document. Check your connection and try again.',
} as const;

/** One match: its 0-based page and the word boxes to highlight (page fractions). */
export interface FindMatch {
  readonly page: number;
  readonly rects: readonly { readonly x: number; readonly y: number; readonly w: number; readonly h: number }[];
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function hasText(layer: TextLayer | null): boolean {
  return layer?.pages.some((p) => p.words.length > 0) === true;
}

/** Every match of `query` in the document, in reading order (page, then word). */
export function findMatches(layer: TextLayer | null, query: string): FindMatch[] {
  const terms = fold(query).trim().split(/\s+/).filter(Boolean);
  if (terms.join(' ').length < MIN_QUERY || layer === null) return [];
  const out: FindMatch[] = [];
  const pages = [...layer.pages].sort((a, b) => a.page - b.page);
  for (const p of pages) {
    const words = p.words.map((w) => fold(w.t));
    for (let i = 0; i + terms.length <= words.length; i += 1) {
      if (matchesAt(words, i, terms)) {
        out.push({ page: p.page - 1, rects: p.words.slice(i, i + terms.length).map(({ x, y, w, h }) => ({ x, y, w, h })) });
      }
    }
  }
  return out;
}

function matchesAt(words: readonly string[], i: number, terms: readonly string[]): boolean {
  if (terms.length === 1) return (words[i] ?? '').includes(terms[0] ?? '');
  for (let k = 0; k < terms.length; k += 1) {
    const w = words[i + k] ?? '';
    const t = terms[k] ?? '';
    const ok = k === 0 ? w.endsWith(t) : k === terms.length - 1 ? w.startsWith(t) : w === t;
    if (!ok) return false;
  }
  return true;
}

/** "3 of 12", or the no-text / too-short / no-matches line (as the app). */
export function findStatus(input: { readonly query: string; readonly matches: readonly FindMatch[]; readonly index: number; readonly searchable: boolean }): string {
  if (!input.searchable) return FIND_COPY.noText;
  if (input.query.trim().length < MIN_QUERY) return FIND_COPY.tooShort;
  if (input.matches.length === 0) return FIND_COPY.none;
  return `${input.index + 1} of ${input.matches.length}`;
}

/** The next index (wraps), `dir` +1 or -1. */
export function stepMatch(index: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return 0;
  return (index + dir + count) % count;
}
