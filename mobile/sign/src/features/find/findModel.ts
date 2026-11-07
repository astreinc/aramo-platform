// M-A12 W1-C.2 — Find in document. The server returns each page's words with boxes
// normalised to the page (0..1, origin top-left; contract §2); the search and the
// highlight happen on the device only. The text is held in memory for the open document
// and never logged or stored.
//
// A query matches a run of consecutive words on one page, case- and accent-insensitive,
// where the first word may end with and the last word may start with the query's edges
// ("ment da" matches "agreement date"). Matches are in reading order: document order,
// page, then word order.
import type { TextLayer } from '../../api/m-a12-contract-types';

export const MIN_QUERY = 2;

export const FIND_COPY = {
  noText: 'No searchable text in this document',
  tooShort: 'Type at least 2 letters',
  none: 'No matches',
  loading: 'Reading the document…',
  failed: 'Couldn’t search this document. Check your connection and try again.',
} as const;

/** A highlight box, normalised to the page (0..1). */
export interface NormRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface FindMatch {
  /** The caller's document key. */
  readonly docKey: string;
  /** 0-based page index. */
  readonly page: number;
  readonly rects: readonly NormRect[];
  /** M-A14 — the first matched word on the page, and how many words matched. */
  readonly word?: number;
  readonly count?: number;
}

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Whether any page of the layers carries a word. */
export function hasText(layers: readonly (TextLayer | null | undefined)[]): boolean {
  return layers.some((l) => l?.pages.some((p) => p.words.length > 0) === true);
}

/** Every match of `query` in the documents, in reading order. */
export function findMatches(
  docs: readonly { readonly docKey: string; readonly layer: TextLayer | null | undefined }[],
  query: string,
): FindMatch[] {
  const terms = fold(query).trim().split(/\s+/).filter(Boolean);
  if (terms.join(' ').length < MIN_QUERY) return [];
  const out: FindMatch[] = [];
  for (const d of docs) {
    const pages = [...(d.layer?.pages ?? [])].sort((a, b) => a.page - b.page);
    for (const p of pages) {
      const words = p.words.map((w) => fold(w.t));
      for (let i = 0; i + terms.length <= words.length; i += 1) {
        if (matchesAt(words, i, terms)) {
          out.push({
            docKey: d.docKey,
            page: p.page - 1,
            rects: p.words.slice(i, i + terms.length).map(({ x, y, w, h }) => ({ x, y, w, h })),
            word: i,
            count: terms.length,
          });
        }
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
    const ok =
      k === 0 ? w.endsWith(t) || w === t : k === terms.length - 1 ? w.startsWith(t) : w === t;
    if (!ok) return false;
  }
  return true;
}

/** "3 of 12" for the current match, or the empty/short/no-text line. */
export function findStatus(input: {
  readonly query: string;
  readonly matches: readonly FindMatch[];
  readonly index: number;
  readonly searchable: boolean;
}): string {
  if (!input.searchable) return FIND_COPY.noText;
  if (input.query.trim().length < MIN_QUERY) return FIND_COPY.tooShort;
  if (input.matches.length === 0) return FIND_COPY.none;
  return `${input.index + 1} of ${input.matches.length}`;
}

/**
 * M-A14 "Find in Document" sheet (a10): "Type at least 2 letters", "No matches" or
 * "N matches · highlighted on the page" (no current-match counter; matches are listed).
 */
export function findListStatus(input: {
  readonly query: string;
  readonly matches: readonly FindMatch[];
  readonly searchable: boolean;
}): string {
  if (!input.searchable) return FIND_COPY.noText;
  if (input.query.trim().length < MIN_QUERY) return FIND_COPY.tooShort;
  const n = input.matches.length;
  if (n === 0) return FIND_COPY.none;
  return `${n} ${n === 1 ? 'match' : 'matches'} · highlighted on the page`;
}

export interface MatchSnippet {
  readonly pre: string;
  readonly hit: string;
  readonly post: string;
}

const SNIPPET_BEFORE = 26;
const SNIPPET_AFTER = 38;

/** The words around a match on its page: up to 26 characters before and 38 after. */
export function matchSnippet(
  words: readonly { readonly t: string }[],
  word: number,
  count: number,
): MatchSnippet {
  const before = words.slice(0, word).map((w) => w.t).join(' ');
  const hit = words.slice(word, word + count).map((w) => w.t).join(' ');
  const after = words.slice(word + count).map((w) => w.t).join(' ');
  const preText = before ? `${before} ` : '';
  const postText = after ? ` ${after}` : '';
  const pre = preText.length > SNIPPET_BEFORE ? `…${preText.slice(-SNIPPET_BEFORE)}` : preText;
  const post = postText.length > SNIPPET_AFTER ? `${postText.slice(0, SNIPPET_AFTER)}…` : postText;
  return { pre, hit, post };
}

/** The next index (wraps), `dir` +1 or -1. */
export function stepMatch(index: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return 0;
  return (index + dir + count) % count;
}

/** The rects to draw on one page, and which of them belong to the current match. */
export function pageHighlights(
  matches: readonly FindMatch[],
  current: number,
  docKey: string,
  page: number,
): { readonly rect: NormRect; readonly current: boolean }[] {
  const out: { rect: NormRect; current: boolean }[] = [];
  matches.forEach((m, i) => {
    if (m.docKey !== docKey || m.page !== page) return;
    for (const rect of m.rects) out.push({ rect, current: i === current });
  });
  return out;
}

// ── Page navigation (W1-C.1) ────────────────────────────────────────────────

/** "Page 3 of 7". */
export function pageLabel(current: number, total: number): string {
  return `Page ${Math.min(Math.max(1, current), Math.max(1, total))} of ${Math.max(1, total)}`;
}

/**
 * The page in view from the pages' top offsets (sorted or not) and the scroll position:
 * the last page whose top is at or above a probe a third down the viewport.
 */
export function pageInView(tops: readonly number[], scrollY: number, viewport: number): number {
  const probe = scrollY + viewport / 3;
  let best = 0;
  const sorted = [...tops].sort((a, b) => a - b);
  sorted.forEach((top, i) => {
    if (top <= probe) best = i;
  });
  return best;
}
