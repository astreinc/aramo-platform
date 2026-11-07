import type { TextLayerPage, TextLayerWord } from './document-text-layer.service.js';

// Aramo Sign Mobile M-A14 R-3 / §2 — "Auto suggest fields", Option A: deterministic detection
// on the document's existing text layer. No model, no network: the words are the ones
// DocumentTextLayerService already extracted on the platform. Nothing here logs text.
//
// What it finds (case-insensitive, whole words):
//   SIGNATURE  "Signature", "Signed", "Signed by", "Sign here"
//   SIGN_DATE  "Date", "Dated", "Date signed"
// A label counts only when it reads as a form label, not prose: it ends with ':', or is
// followed by an underline ("____"), or sits under an underline, or its line is short.
//
// Where the box goes (first that applies):
//   1  on the underline that follows the label on the same line ("Signature: ________");
//   2  on the underline just above the label ("________" over "Signature");
//   3  right after the label on the same line, up to the next word or the page margin.
//
// Which ones are returned: only pages that hold a signature suggestion (a date suggestion on
// a page without one is the letter's date, not a signing date), the LAST such pages first
// (the signature block), overlapping boxes removed, at most SUGGESTION_LIMIT.
//
// Units: the frame envelope fields use (PUT .../fields, SenderFieldInput): page_number 0-based,
// PDF points, origin at the page's BOTTOM-LEFT, (x, y) the box's lower-left corner. The text
// layer's boxes are 0..1 of the displayed page view (the crop box), origin top-left; they are
// converted with the page's crop box and clamped inside its media box (what replaceFields
// validates against). A rotated page gets no suggestions (its view is not the field frame).

export type SuggestedFieldType = 'SIGNATURE' | 'SIGN_DATE';

export interface FieldSuggestion {
  type: SuggestedFieldType;
  /** 1-based page number (as in the text layer). */
  page: number;
  /** 0-based page index, exactly the PUT fields `page_number`. */
  page_number: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One page's geometry in PDF user space (points). */
export interface PageFrame {
  /** The media box size (the field frame replaceFields validates against). */
  width: number;
  height: number;
  /** The crop box: the view the text layer's 0..1 boxes are relative to. */
  view: { x: number; y: number; width: number; height: number };
  /** Page rotation in degrees. */
  rotation: number;
}

export const SUGGESTION_LIMIT = 6;
// The editors' default sizes (mobile FIELD_TYPE_SPECS / handoff §4.6), in points.
export const SUGGESTED_SIZE: Readonly<Record<SuggestedFieldType, { width: number; height: number }>> = {
  SIGNATURE: { width: 230, height: 50 },
  SIGN_DATE: { width: 150, height: 22 },
};
const MIN_SIZE: Readonly<Record<SuggestedFieldType, { width: number; height: number }>> = {
  SIGNATURE: { width: 90, height: 24 },
  SIGN_DATE: { width: 60, height: 16 },
};
// An underline wider than this is used up to this width.
const MAX_UNDERLINE_WIDTH: Readonly<Record<SuggestedFieldType, number>> = { SIGNATURE: 300, SIGN_DATE: 200 };
const GAP = 4;
const SHORT_LINE_WORDS = 6;

// A word in points, top-left origin (the view's frame).
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Word extends Box {
  key: string;
  colon: boolean;
  underline: boolean;
}
interface Proposal extends Box {
  type: SuggestedFieldType;
}

const UNDERLINE = /_{3,}/;

function keyOf(t: string): string {
  return t.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

/** Words of one page in points; a word like "Signature:_____" is split into label + underline. */
function wordsOf(words: readonly TextLayerWord[], vw: number, vh: number): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    const box = { x: w.x * vw, y: w.y * vh, w: w.w * vw, h: w.h * vh };
    const m = UNDERLINE.exec(w.t);
    if (m === null) {
      out.push({ ...box, key: keyOf(w.t), colon: /:\s*$/.test(w.t), underline: false });
      continue;
    }
    // Apportion the word's box by character position (as wordsOfRun does for runs).
    const len = w.t.length;
    const at = (i: number): number => box.x + (i / len) * box.w;
    const before = w.t.slice(0, m.index);
    if (keyOf(before).length > 0) out.push({ x: box.x, y: box.y, w: at(m.index) - box.x, h: box.h, key: keyOf(before), colon: /:\s*$/.test(before), underline: false });
    out.push({ x: at(m.index), y: box.y, w: at(m.index + m[0].length) - at(m.index), h: box.h, key: '', colon: false, underline: true });
  }
  return out;
}

/** Groups words into lines (by vertical centre), each sorted left to right, lines top to bottom. */
function linesOf(words: Word[]): Word[][] {
  const sorted = [...words].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
  const lines: Array<{ cy: number; h: number; words: Word[] }> = [];
  for (const w of sorted) {
    const cy = w.y + w.h / 2;
    const last = lines[lines.length - 1];
    if (last !== undefined && Math.abs(cy - last.cy) <= Math.max(last.h, w.h) * 0.5) {
      last.words.push(w);
      continue;
    }
    lines.push({ cy, h: w.h, words: [w] });
  }
  return lines.map((l) => {
    const ws = l.words.sort((a, b) => a.x - b.x);
    // Adjacent underline pieces ("____ ____") read as one underline.
    const merged: Word[] = [];
    for (const w of ws) {
      const prev = merged[merged.length - 1];
      if (prev !== undefined && prev.underline && w.underline && w.x - (prev.x + prev.w) <= prev.h) {
        const right = Math.max(prev.x + prev.w, w.x + w.w);
        merged[merged.length - 1] = { ...prev, y: Math.min(prev.y, w.y), w: right - prev.x, h: Math.max(prev.y + prev.h, w.y + w.h) - Math.min(prev.y, w.y) };
      } else merged.push(w);
    }
    return merged;
  });
}

/** The label starting at line[i], if any: its type and how many words it spans. */
function labelAt(line: Word[], i: number): { type: SuggestedFieldType; span: number } | null {
  const k = line[i]?.key ?? '';
  const next = line[i + 1]?.key ?? '';
  const prev = line[i - 1]?.key ?? '';
  if (k === 'date' && next === 'signed') return { type: 'SIGN_DATE', span: 2 };
  if (k === 'date' || k === 'dated') return { type: 'SIGN_DATE', span: 1 };
  if (k === 'signed' && prev === 'date') return null; // the tail of "Date signed"
  if (k === 'signed' && next === 'by') return { type: 'SIGNATURE', span: 2 };
  if (k === 'sign' && next === 'here') return { type: 'SIGNATURE', span: 2 };
  if (k === 'signature' || k === 'signed') return { type: 'SIGNATURE', span: 1 };
  return null;
}

const overlapsX = (a: Box, x0: number, x1: number): boolean => a.x < x1 && a.x + a.w > x0;
const intersects = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The box height that fits above `bottom` without covering the nearest text above. */
function heightAbove(type: SuggestedFieldType, lines: Word[][], x0: number, x1: number, bottom: number, ownLine: Word[]): number {
  let ceiling = 0;
  for (const line of lines) {
    if (line === ownLine) continue;
    for (const w of line) {
      if (w.underline || !overlapsX(w, x0, x1)) continue;
      const wb = w.y + w.h;
      if (wb <= bottom - 1 && wb > ceiling) ceiling = wb;
    }
  }
  const room = bottom - ceiling - 2;
  return Math.max(MIN_SIZE[type].height, Math.min(SUGGESTED_SIZE[type].height, room));
}

function proposalsOfPage(page: TextLayerPage, frame: PageFrame): Proposal[] {
  const vw = frame.view.width;
  const vh = frame.view.height;
  const lines = linesOf(wordsOf(page.words, vw, vh));
  const margin = Math.max(12, vw * 0.03);
  const out: Proposal[] = [];
  for (const [li, line] of lines.entries()) {
    for (let i = 0; i < line.length; i += 1) {
      const label = labelAt(line, i);
      if (label === null) continue;
      const first = line[i] as Word;
      const last = line[i + label.span - 1] as Word;
      const labelBox: Box = { x: first.x, y: Math.min(first.y, last.y), w: last.x + last.w - first.x, h: Math.max(first.h, last.h) };
      const after = line[i + label.span];
      const textWords = line.filter((w) => !w.underline).length;
      // 2 — an underline just above the label (within three label heights), overlapping it.
      let above: Word | undefined;
      let aboveLine: Word[] = line;
      for (let lj = li - 1; lj >= 0 && above === undefined; lj -= 1) {
        const prior = lines[lj] ?? [];
        const top = Math.min(...prior.map((w) => w.y));
        if (labelBox.y - top > labelBox.h * 3.5) break;
        above = prior.find((w) => w.underline && overlapsX(w, labelBox.x - labelBox.h, labelBox.x + labelBox.w + labelBox.h));
        aboveLine = prior;
      }
      const formLike = last.colon || after?.underline === true || above !== undefined || textWords <= SHORT_LINE_WORDS;
      if (!formLike) continue;
      const def = SUGGESTED_SIZE[label.type];
      const min = MIN_SIZE[label.type];
      let x: number;
      let width: number;
      let bottom: number;
      let anchorLine = line;
      if (after?.underline === true) {
        // 1 — on the underline that follows.
        x = after.x;
        width = Math.min(Math.max(after.w, min.width), MAX_UNDERLINE_WIDTH[label.type]);
        bottom = after.y + after.h;
      } else if (above !== undefined && (after === undefined || textWords <= SHORT_LINE_WORDS)) {
        // 2 — on the underline above.
        x = above.x;
        width = Math.min(Math.max(above.w, min.width), MAX_UNDERLINE_WIDTH[label.type]);
        bottom = above.y + above.h;
        anchorLine = aboveLine;
      } else {
        // 3 — right after the label, up to the next word (or the page margin).
        x = labelBox.x + labelBox.w + GAP;
        const limit = after !== undefined ? after.x - GAP : vw - margin;
        width = Math.min(def.width, limit - x);
        if (width < min.width) continue;
        bottom = labelBox.y + labelBox.h + 2;
      }
      const height = heightAbove(label.type, lines, x, x + width, bottom, anchorLine);
      out.push({ type: label.type, x, y: bottom - height, w: width, h: height });
      i += label.span - 1;
    }
  }
  return out;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Converts a top-left view box to the field frame; null when it cannot fit the page. */
function toFieldFrame(c: Proposal, pageIndex: number, frame: PageFrame): FieldSuggestion | null {
  const min = MIN_SIZE[c.type];
  let x = frame.view.x + c.x;
  let y = frame.view.y + (frame.view.height - (c.y + c.h));
  let width = c.w;
  let height = c.h;
  // Clamp inside the media box (replaceFields refuses a box outside the page).
  if (x < 0) {
    width += x;
    x = 0;
  }
  if (y < 0) {
    height += y;
    y = 0;
  }
  width = Math.min(width, frame.width - x);
  height = Math.min(height, frame.height - y);
  if (width < min.width || height < min.height) return null;
  return { type: c.type, page: pageIndex + 1, page_number: pageIndex, x: round2(x), y: round2(y), width: Math.floor(width * 100) / 100, height: Math.floor(height * 100) / 100 };
}

/**
 * Deterministic SIGNATURE / SIGN_DATE suggestions for one document. `pages` is its text layer,
 * `frames` the geometry of each page by position (frames[0] = page 1). Never throws on odd
 * input: a page without a frame, with no words or rotated yields nothing.
 */
export function suggestFields(pages: readonly TextLayerPage[], frames: readonly PageFrame[], limit = SUGGESTION_LIMIT): FieldSuggestion[] {
  const perPage: Array<{ index: number; items: FieldSuggestion[] }> = [];
  for (const page of pages) {
    const index = page.page - 1;
    const frame = frames[index];
    if (frame === undefined || page.words.length === 0) continue;
    if (((frame.rotation % 360) + 360) % 360 !== 0) continue;
    if (frame.view.width <= 0 || frame.view.height <= 0) continue;
    const proposals = proposalsOfPage(page, frame);
    if (!proposals.some((c) => c.type === 'SIGNATURE')) continue;
    // Dedupe: a later box that overlaps an earlier one on the page is dropped.
    const kept: Proposal[] = [];
    for (const c of proposals) if (!kept.some((k) => intersects(k, c))) kept.push(c);
    const items = kept
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((c) => toFieldFrame(c, index, frame))
      .filter((s): s is FieldSuggestion => s !== null);
    if (items.some((s) => s.type === 'SIGNATURE')) perPage.push({ index, items });
  }
  // The last pages first (the signature block), then back in reading order.
  const chosen: FieldSuggestion[] = [];
  for (const p of perPage.sort((a, b) => b.index - a.index)) {
    for (const s of p.items) {
      if (chosen.length >= limit) break;
      chosen.push(s);
    }
    if (chosen.length >= limit) break;
  }
  return chosen.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
}
