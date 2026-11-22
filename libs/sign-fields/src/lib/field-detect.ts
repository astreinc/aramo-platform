// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §5 P2-4 —
// "Auto-detect suggestions everywhere". The ONE deterministic field detector, shared by the Sign
// envelope route (apps/sign-service, GET …/documents/{documentId}/field-suggestions) and the
// console fixed-form route (apps/api, GET …/fixed-form/field-suggestions). The PDF reading (the
// text layer, the page frames and the drawn rectangles) is @aramo/documents-rendering; this file
// only reasons about what was read. No model, no network, no logging of text.
//
// Two modes:
//   suggestSignatureBlock  Aramo Sign Mobile M-A14 R-3 (moved here unchanged from
//                          apps/sign-service/src/app/text-layer/field-suggestions.ts): SIGNATURE /
//                          SIGN_DATE next to signature and date labels, only on pages that hold a
//                          signature, the last such pages first, at most 6. The route's default.
//   detectFields           P2-4: every page, many types, a raised limit (DETECT_LIMIT):
//                            label patterns  ("Signature:", "Name:", "Title:", "Date:", …) →
//                                            the label's type, on the line / in the empty space
//                                            next to (or below) the label;
//                            underscore runs ("______") → TEXT sized to the run;
//                            empty boxes / table cells (drawn rectangles and ruled grids that
//                                            hold no text) → TEXT, or CHECKBOX when small and
//                                            square;
//                            checkbox glyphs (☐ □) → CHECKBOX at the glyph.
//                          Overlapping suggestions are removed (the more confident one stays);
//                          a rotated page gets none and is reported with a reason.
//
// Frames. In: the text layer's words and the drawn rectangles are 0..1 of the page VIEW (the crop
// box), origin top-left; the page frame gives the view and the media box. Out: the frame every
// host stores (SenderFieldInput / FixedFormField): page_number 0-based, PDF points, origin at the
// page's BOTTOM-LEFT, (x, y) the box's lower-left corner, inside the media box.
//
// Pure TypeScript ESM, no dependency (scope:shared).

import { FIELD_DEFAULTS, isFieldTypeOn, type FieldTypeKey, type FieldTypeOn } from './catalog.js';

// ── Input / output shapes ───────────────────────────────────────────────────────

/** One word of the text layer: 0..1 of the page view, origin top-left. */
export interface DetectWord {
  readonly t: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface DetectTextPage {
  /** 1-based page number. */
  readonly page: number;
  readonly words: readonly DetectWord[];
}

/** A drawn rectangle or straight line (w or h may be 0): 0..1 of the page view, origin top-left. */
export interface DetectRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly stroke: boolean;
  readonly fill: boolean;
}

export interface DetectGraphicsPage {
  /** 1-based page number. */
  readonly page: number;
  readonly rects: readonly DetectRect[];
}

/** One page's geometry in PDF user space (points). */
export interface DetectPageFrame {
  /** The media box size (the field frame hosts validate against). */
  readonly width: number;
  readonly height: number;
  /** The crop box: the view the 0..1 boxes are relative to. */
  readonly view: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** Page rotation in degrees. */
  readonly rotation: number;
}

/** The catalog's `suggestion` surface: every type the detector may propose. */
export type SuggestedFieldType = FieldTypeOn<'suggestion'>;

/** M-A14 — the signature-block mode proposes only these two. */
export type SignatureBlockFieldType = 'SIGNATURE' | 'SIGN_DATE';

export interface SignatureBlockSuggestion {
  readonly type: SignatureBlockFieldType;
  /** 1-based page number (as in the text layer). */
  readonly page: number;
  /** 0-based page index (the stored field's page_number). */
  readonly page_number: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Why a suggestion was made: `label:<Label>`, or one of the shape rules. */
export type DetectReason = `label:${string}` | 'underscore_line' | 'empty_box' | 'empty_cell' | 'checkbox_glyph';

export interface DetectedField {
  readonly type: SuggestedFieldType;
  readonly page: number;
  readonly page_number: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly reason: DetectReason;
  /** 0..1: how sure the rule is (a label on its line > a glyph > a box > a bare line). */
  readonly confidence: number;
}

export interface SkippedPage {
  readonly page: number;
  readonly reason: 'rotated';
}

export interface DetectResult {
  readonly suggestions: DetectedField[];
  readonly skipped_pages: SkippedPage[];
}

export interface DetectOptions {
  /** The drawn rectangles of each page (absent: the box / cell rules are off). */
  readonly graphics?: readonly DetectGraphicsPage[];
  /**
   * The types the host may place (its palette surface). A label type the host lacks becomes
   * TEXT when TEXT is allowed (e.g. "Title:" on a fixed form), otherwise it is dropped.
   */
  readonly types?: readonly FieldTypeKey[];
  readonly limit?: number;
}

/** M-A14 — the signature-block mode's cap (unchanged). */
export const SUGGESTION_LIMIT = 6;
/** P2-4 — the detector's cap per document. */
export const DETECT_LIMIT = 300;

// The editors' default sizes (the catalog's one table, P1-0), in points.
export const SUGGESTED_SIZE: Readonly<Record<SignatureBlockFieldType, { width: number; height: number }>> = {
  SIGNATURE: { width: FIELD_DEFAULTS.SIGNATURE.width, height: FIELD_DEFAULTS.SIGNATURE.height },
  SIGN_DATE: { width: FIELD_DEFAULTS.SIGN_DATE.width, height: FIELD_DEFAULTS.SIGN_DATE.height },
};

/** The smallest box a suggestion of each type may have (points). */
export const DETECT_MIN_SIZE: Readonly<Record<SuggestedFieldType, { width: number; height: number }>> = {
  SIGNATURE: { width: 90, height: 24 },
  SIGN_DATE: { width: 60, height: 16 },
  INITIALS: { width: 30, height: 16 },
  TEXT: { width: 30, height: 12 },
  SIGNER_NAME: { width: 60, height: 14 },
  CHECKBOX: { width: 8, height: 8 },
  EMAIL: { width: 60, height: 14 },
  COMPANY: { width: 60, height: 14 },
  TITLE: { width: 60, height: 14 },
};
// An underline / rule / cell wider than this is used up to this width.
const MAX_WIDTH: Readonly<Record<SuggestedFieldType, number>> = {
  SIGNATURE: 300,
  SIGN_DATE: 200,
  INITIALS: 120,
  TEXT: 520,
  SIGNER_NAME: 300,
  CHECKBOX: 20,
  EMAIL: 300,
  COMPANY: 300,
  TITLE: 300,
};

const CONFIDENCE = {
  labelOnLine: 0.95,
  labelInCell: 0.9,
  labelBeside: 0.8,
  labelBelow: 0.7,
  checkbox_glyph: 0.85,
  empty_box: 0.6,
  empty_cell: 0.55,
  underscore_line: 0.5,
} as const;

const GAP = 4;
const SHORT_LINE_WORDS = 6;
const CHECKBOX_GLYPHS = '☐□☑☒';
const CHECKBOX_MIN = 8;
const CHECKBOX_MAX = 20;
/** A drawn shape at most this thick (points) is a rule (a line), not a box. */
const RULE_MAX = 2.5;
/** Grid bounds: a page with more distinct rule positions than this is not read as a table. */
const GRID_MAX_LINES = 160;
const RECT_MAX = 4000;

// ── Geometry (top-left points of the page view) ─────────────────────────────────

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
  glyph: boolean;
}

const UNDERLINE = /_{3,}/;
const SPLIT = new RegExp(`_{3,}|[${CHECKBOX_GLYPHS}]`, 'g');

function keyOf(t: string): string {
  return t.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

/**
 * Words of one page in points; "Signature:_____" splits into label + underline and "☐Yes" into
 * glyph + word. Boxes are apportioned by character position (as wordsOfRun does for runs).
 * `glyphs` false keeps the M-A14 split (underlines only).
 */
function wordsOf(words: readonly DetectWord[], vw: number, vh: number, glyphs: boolean): Word[] {
  const out: Word[] = [];
  const re = glyphs ? SPLIT : new RegExp(UNDERLINE.source, 'g');
  for (const w of words) {
    const box = { x: w.x * vw, y: w.y * vh, w: w.w * vw, h: w.h * vh };
    const t = w.t;
    const len = t.length;
    if (len === 0) continue;
    const at = (i: number): number => box.x + (i / len) * box.w;
    const push = (from: number, to: number): void => {
      const s = t.slice(from, to);
      if (keyOf(s).length === 0) return;
      out.push({ x: at(from), y: box.y, w: at(to) - at(from), h: box.h, key: keyOf(s), colon: /:\s*$/.test(s), underline: false, glyph: false });
    };
    re.lastIndex = 0;
    let last = 0;
    let m: RegExpExecArray | null;
    let any = false;
    while ((m = re.exec(t)) !== null) {
      any = true;
      push(last, m.index);
      const end = m.index + m[0].length;
      const underline = m[0].startsWith('_');
      out.push({ x: at(m.index), y: box.y, w: at(end) - at(m.index), h: box.h, key: '', colon: false, underline, glyph: !underline });
      last = end;
    }
    if (!any) {
      out.push({ ...box, key: keyOf(t), colon: /:\s*$/.test(t), underline: false, glyph: false });
      continue;
    }
    push(last, len);
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

const overlapsX = (a: Box, x0: number, x1: number): boolean => a.x < x1 && a.x + a.w > x0;
const intersects = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const area = (b: Box): number => Math.max(0, b.w) * Math.max(0, b.h);
function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
const contains = (outer: Box, x: number, y: number, inset = 0): boolean => x > outer.x + inset && x < outer.x + outer.w - inset && y > outer.y + inset && y < outer.y + outer.h - inset;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const floor2 = (n: number): number => Math.floor(n * 100) / 100;

/** Converts a top-left view box to the field frame; null when it cannot fit the page. */
function toFieldFrame(b: Box, min: { width: number; height: number }, frame: DetectPageFrame): { x: number; y: number; width: number; height: number } | null {
  let x = frame.view.x + b.x;
  let y = frame.view.y + (frame.view.height - (b.y + b.h));
  let width = b.w;
  let height = b.h;
  // Clamp inside the media box (hosts refuse a box outside the page).
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
  return { x: round2(x), y: round2(y), width: floor2(width), height: floor2(height) };
}

const usable = (frame: DetectPageFrame | undefined): frame is DetectPageFrame => frame !== undefined && frame.view.width > 0 && frame.view.height > 0;
const rotated = (frame: DetectPageFrame): boolean => ((frame.rotation % 360) + 360) % 360 !== 0;

// ── M-A14 signature-block mode (unchanged behaviour) ────────────────────────────

interface BlockProposal extends Box {
  type: SignatureBlockFieldType;
}

const BLOCK_MIN: Readonly<Record<SignatureBlockFieldType, { width: number; height: number }>> = { SIGNATURE: DETECT_MIN_SIZE.SIGNATURE, SIGN_DATE: DETECT_MIN_SIZE.SIGN_DATE };

/** The M-A14 label starting at line[i], if any: its type and how many words it spans. */
function blockLabelAt(line: Word[], i: number): { type: SignatureBlockFieldType; span: number } | null {
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

/** The box height that fits above `bottom` without covering the nearest text above. */
function heightAbove(def: number, min: number, lines: Word[][], x0: number, x1: number, bottom: number, ownLine: Word[] | null): number {
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
  return Math.max(min, Math.min(def, room));
}

function blockProposalsOfPage(page: DetectTextPage, frame: DetectPageFrame): BlockProposal[] {
  const vw = frame.view.width;
  const vh = frame.view.height;
  const lines = linesOf(wordsOf(page.words, vw, vh, false));
  const margin = Math.max(12, vw * 0.03);
  const out: BlockProposal[] = [];
  for (const [li, line] of lines.entries()) {
    for (let i = 0; i < line.length; i += 1) {
      const label = blockLabelAt(line, i);
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
      const min = BLOCK_MIN[label.type];
      let x: number;
      let width: number;
      let bottom: number;
      let anchorLine = line;
      if (after?.underline === true) {
        // 1 — on the underline that follows.
        x = after.x;
        width = Math.min(Math.max(after.w, min.width), MAX_WIDTH[label.type]);
        bottom = after.y + after.h;
      } else if (above !== undefined && (after === undefined || textWords <= SHORT_LINE_WORDS)) {
        // 2 — on the underline above.
        x = above.x;
        width = Math.min(Math.max(above.w, min.width), MAX_WIDTH[label.type]);
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
      const height = heightAbove(def.height, min.height, lines, x, x + width, bottom, anchorLine);
      out.push({ type: label.type, x, y: bottom - height, w: width, h: height });
      i += label.span - 1;
    }
  }
  return out;
}

/**
 * M-A14 — deterministic SIGNATURE / SIGN_DATE suggestions for one document. `pages` is its text
 * layer, `frames` the geometry of each page by position (frames[0] = page 1). Never throws on
 * odd input: a page without a frame, with no words or rotated yields nothing.
 */
export function suggestSignatureBlock(pages: readonly DetectTextPage[], frames: readonly DetectPageFrame[], limit = SUGGESTION_LIMIT): SignatureBlockSuggestion[] {
  const perPage: Array<{ index: number; items: SignatureBlockSuggestion[] }> = [];
  for (const page of pages) {
    const index = page.page - 1;
    const frame = frames[index];
    if (!usable(frame) || page.words.length === 0 || rotated(frame)) continue;
    const proposals = blockProposalsOfPage(page, frame);
    if (!proposals.some((c) => c.type === 'SIGNATURE')) continue;
    // Dedupe: a later box that overlaps an earlier one on the page is dropped.
    const kept: BlockProposal[] = [];
    for (const c of proposals) if (!kept.some((k) => intersects(k, c))) kept.push(c);
    const items = kept
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .flatMap((c) => {
        const f = toFieldFrame(c, BLOCK_MIN[c.type], frame);
        return f === null ? [] : [{ type: c.type, page: index + 1, page_number: index, ...f }];
      });
    if (items.some((s) => s.type === 'SIGNATURE')) perPage.push({ index, items });
  }
  // The last pages first (the signature block), then back in reading order.
  const chosen: SignatureBlockSuggestion[] = [];
  for (const p of perPage.sort((a, b) => b.index - a.index)) {
    for (const s of p.items) {
      if (chosen.length >= limit) break;
      chosen.push(s);
    }
    if (chosen.length >= limit) break;
  }
  return chosen.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
}

// ── P2-4 detector ───────────────────────────────────────────────────────────────

/** A label pattern: its words (keys), the type it proposes, the label shown in `reason`. */
interface LabelRule {
  readonly words: readonly string[];
  readonly type: SuggestedFieldType;
  readonly label: string;
}

// Longest first within each type, so "Printed name" wins over "Name" and "Date signed" over "Date".
const LABEL_RULES: readonly LabelRule[] = [
  { words: ['signature'], type: 'SIGNATURE', label: 'Signature' },
  { words: ['sign', 'here'], type: 'SIGNATURE', label: 'Sign here' },
  { words: ['signed', 'by'], type: 'SIGNATURE', label: 'Signed by' },
  { words: ['initial', 'here'], type: 'INITIALS', label: 'Initial here' },
  { words: ['initials'], type: 'INITIALS', label: 'Initials' },
  { words: ['date', 'signed'], type: 'SIGN_DATE', label: 'Date signed' },
  { words: ['dated'], type: 'SIGN_DATE', label: 'Dated' },
  { words: ['date'], type: 'SIGN_DATE', label: 'Date' },
  { words: ['company', 'name'], type: 'COMPANY', label: 'Company name' },
  { words: ['company'], type: 'COMPANY', label: 'Company' },
  { words: ['organization'], type: 'COMPANY', label: 'Organization' },
  { words: ['organisation'], type: 'COMPANY', label: 'Organisation' },
  { words: ['printed', 'name'], type: 'SIGNER_NAME', label: 'Printed name' },
  { words: ['print', 'name'], type: 'SIGNER_NAME', label: 'Print name' },
  { words: ['full', 'name'], type: 'SIGNER_NAME', label: 'Full name' },
  { words: ['name'], type: 'SIGNER_NAME', label: 'Name' },
  { words: ['job', 'title'], type: 'TITLE', label: 'Job title' },
  { words: ['title'], type: 'TITLE', label: 'Title' },
  { words: ['email', 'address'], type: 'EMAIL', label: 'Email address' },
  { words: ['email'], type: 'EMAIL', label: 'Email' },
  { words: ['e-mail'], type: 'EMAIL', label: 'Email' },
  { words: ['signed'], type: 'SIGNATURE', label: 'Signed' },
];
// The M-A14 types keep the M-A14 "short line" leniency; the others need a stronger form cue.
const LENIENT: ReadonlySet<SuggestedFieldType> = new Set(['SIGNATURE', 'SIGN_DATE']);

interface Proposal extends Box {
  type: SuggestedFieldType;
  reason: DetectReason;
  confidence: number;
  /** A date label proposal: decided SIGN_DATE / TEXT once the page's signatures are known. */
  dateLabel?: boolean;
}

/** A word key normalised for label matching ("E-mail:" → "e-mail"). */
const labelKey = (w: Word | undefined): string => (w === undefined || w.underline || w.glyph ? '' : w.key.replace(/[^a-z0-9-]/g, ''));

function labelRuleAt(line: Word[], i: number): LabelRule | null {
  // "Date signed": "signed" right after "date" is part of that label, never its own.
  if (labelKey(line[i]) === 'signed' && labelKey(line[i - 1]) === 'date') return null;
  for (const r of LABEL_RULES) {
    if (r.words.every((k, j) => labelKey(line[i + j]) === k)) {
      // A label ends at its last word: "Name of the company" is prose, not "Name".
      const last = line[i + r.words.length - 1] as Word;
      const next = line[i + r.words.length];
      if (!last.colon && next !== undefined && !next.underline && !next.glyph && next.x - (last.x + last.w) < last.h * 1.2 && labelKey(next) !== '' && !LENIENT.has(r.type)) return null;
      return r;
    }
  }
  return null;
}

/** The drawn page structure in top-left points: rules (lines) and closed areas (boxes, cells). */
interface PageShapes {
  hRules: Box[];
  areas: Array<Box & { kind: 'empty_box' | 'empty_cell' }>;
}

interface Interval {
  a: number;
  b: number;
}

function mergeIntervals(xs: Interval[], gap: number): Interval[] {
  const s = [...xs].sort((p, q) => p.a - q.a);
  const out: Interval[] = [];
  for (const iv of s) {
    const last = out[out.length - 1];
    if (last !== undefined && iv.a <= last.b + gap) last.b = Math.max(last.b, iv.b);
    else out.push({ ...iv });
  }
  return out;
}

const covers = (ivs: readonly Interval[] | undefined, a: number, b: number, tol: number): boolean => ivs !== undefined && ivs.some((iv) => iv.a <= a + tol && iv.b >= b - tol);

/** Clusters positions within `tol` (sorted ascending), returning each cluster's mean. */
function clusterPositions(values: number[], tol: number): number[] {
  const s = [...values].sort((a, b) => a - b);
  const out: Array<{ sum: number; n: number; last: number }> = [];
  for (const v of s) {
    const c = out[out.length - 1];
    if (c !== undefined && v - c.last <= tol) {
      c.sum += v;
      c.n += 1;
      c.last = v;
    } else out.push({ sum: v, n: 1, last: v });
  }
  return out.map((c) => c.sum / c.n);
}

function nearest(cluster: readonly number[], v: number, tol: number): number | null {
  let best: number | null = null;
  for (const c of cluster) if (Math.abs(c - v) <= tol && (best === null || Math.abs(c - v) < Math.abs(best - v))) best = c;
  return best;
}

function shapesOf(rects: readonly DetectRect[], vw: number, vh: number): PageShapes {
  const hRules: Box[] = [];
  const vRules: Box[] = [];
  const boxes: Box[] = [];
  for (const r of rects.slice(0, RECT_MAX)) {
    const b = { x: r.x * vw, y: r.y * vh, w: r.w * vw, h: r.h * vh };
    if (b.w < 0 || b.h < 0) continue;
    if (b.h <= RULE_MAX && b.w >= 8) hRules.push(b);
    else if (b.w <= RULE_MAX && b.h >= 6) vRules.push(b);
    else if (r.stroke && b.w > RULE_MAX && b.h > RULE_MAX) {
      boxes.push(b);
      // A stroked box's edges also take part in a ruled grid.
      hRules.push({ x: b.x, y: b.y, w: b.w, h: 0 }, { x: b.x, y: b.y + b.h, w: b.w, h: 0 });
      vRules.push({ x: b.x, y: b.y, w: 0, h: b.h }, { x: b.x + b.w, y: b.y, w: 0, h: b.h });
    }
  }
  const tol = 1.5;
  const cells: Box[] = [];
  const ys = clusterPositions(hRules.map((r) => r.y + r.h / 2), tol);
  const xs = clusterPositions(vRules.map((r) => r.x + r.w / 2), tol);
  if (ys.length >= 2 && xs.length >= 2 && ys.length <= GRID_MAX_LINES && xs.length <= GRID_MAX_LINES) {
    const hAt = new Map<number, Interval[]>();
    const vAt = new Map<number, Interval[]>();
    for (const r of hRules) {
      const y = nearest(ys, r.y + r.h / 2, tol);
      if (y !== null) hAt.set(y, [...(hAt.get(y) ?? []), { a: r.x, b: r.x + r.w }]);
    }
    for (const r of vRules) {
      const x = nearest(xs, r.x + r.w / 2, tol);
      if (x !== null) vAt.set(x, [...(vAt.get(x) ?? []), { a: r.y, b: r.y + r.h }]);
    }
    for (const [k, v] of hAt) hAt.set(k, mergeIntervals(v, 2));
    for (const [k, v] of vAt) vAt.set(k, mergeIntervals(v, 2));
    const T = 2;
    for (let i = 0; i < ys.length; i += 1) {
      const top = ys[i] as number;
      for (let a = 0; a < xs.length; a += 1) {
        const left = xs[a] as number;
        // The cell's bottom: the next rule below whose left end the left edge reaches.
        let bottom: number | null = null;
        for (let j = i + 1; j < ys.length; j += 1) {
          const y = ys[j] as number;
          if (!covers(vAt.get(left), top, y, T)) break;
          if (covers(hAt.get(y), left, left + 1, T)) {
            bottom = y;
            break;
          }
        }
        if (bottom === null) continue;
        // The cell's right edge: the next vertical rule spanning top..bottom, with both
        // horizontal rules spanning left..right.
        for (let b = a + 1; b < xs.length; b += 1) {
          const right = xs[b] as number;
          if (!covers(hAt.get(top), left, right, T) || !covers(hAt.get(bottom), left, right, T)) break;
          if (covers(vAt.get(right), top, bottom, T)) {
            cells.push({ x: left, y: top, w: right - left, h: bottom - top });
            break;
          }
        }
      }
    }
  }
  const pageArea = vw * vh;
  const same = (p: Box, q: Box): boolean => Math.abs(p.x - q.x) <= 2 && Math.abs(p.y - q.y) <= 2 && Math.abs(p.w - q.w) <= 2 && Math.abs(p.h - q.h) <= 2;
  const found: Array<Box & { kind: 'empty_box' | 'empty_cell' }> = [];
  for (const b of boxes) if (!found.some((c) => same(c, b))) found.push({ ...b, kind: 'empty_box' });
  for (const c of cells) if (!found.some((k) => same(k, c))) found.push({ ...c, kind: 'empty_cell' });
  // Keep the innermost areas only (a table's frame or a page border holds other areas), and
  // never a page-sized frame.
  const areas = found.filter(
    (c) =>
      c.w >= CHECKBOX_MIN &&
      c.h >= CHECKBOX_MIN &&
      area(c) <= pageArea * 0.35 &&
      !found.some((o) => o !== c && !same(o, c) && o.x >= c.x - 1 && o.y >= c.y - 1 && o.x + o.w <= c.x + c.w + 1 && o.y + o.h <= c.y + c.h + 1),
  );
  // Rules that are not part of a closed area: possible signature / text lines.
  const lines = hRules.filter((r) => r.h > 0 || boxes.length === 0 || !boxes.some((b) => Math.abs(b.y - r.y) <= 1 || Math.abs(b.y + b.h - r.y) <= 1));
  // A rule along any area's top or bottom edge is that area's border (a table rule), not a line.
  const freeLines = lines.filter((r) => !areas.some((c) => overlapsX(r, c.x + 1, c.x + c.w - 1) && (Math.abs(c.y - (r.y + r.h / 2)) <= 2 || Math.abs(c.y + c.h - (r.y + r.h / 2)) <= 2)));
  return { hRules: freeLines, areas };
}

const textIn = (b: Box, words: readonly Word[]): boolean => words.some((w) => !w.underline && contains(b, w.x + w.w / 2, w.y + w.h / 2, 0.5));

const isSquare = (b: Box): boolean => b.w >= CHECKBOX_MIN && b.h >= CHECKBOX_MIN && b.w <= CHECKBOX_MAX && b.h <= CHECKBOX_MAX && Math.abs(b.w - b.h) <= 3;

function proposalsOfPage(page: DetectTextPage, graphics: DetectGraphicsPage | undefined, frame: DetectPageFrame): Proposal[] {
  const vw = frame.view.width;
  const vh = frame.view.height;
  const words = wordsOf(page.words, vw, vh, true);
  const lines = linesOf(words);
  const shapes: PageShapes = graphics === undefined ? { hRules: [], areas: [] } : shapesOf(graphics.rects, vw, vh);
  const margin = Math.max(12, vw * 0.03);
  const out: Proposal[] = [];
  const emptyAreas = shapes.areas.filter((c) => !textIn(c, words));
  const usedLines = new Set<Word>();

  const sizeOf = (type: SuggestedFieldType): { width: number; height: number } => ({ width: FIELD_DEFAULTS[type].width, height: FIELD_DEFAULTS[type].height });
  const fitWidth = (type: SuggestedFieldType, w: number): number => Math.min(Math.max(w, DETECT_MIN_SIZE[type].width), MAX_WIDTH[type]);
  /** A box standing on a line at `bottom`, as tall as the default allows under the text above. */
  const onLine = (type: SuggestedFieldType, reason: DetectReason, confidence: number, x: number, width: number, bottom: number, ownLine: Word[] | null): Proposal => {
    const h = heightAbove(sizeOf(type).height, DETECT_MIN_SIZE[type].height, lines, x, x + width, bottom, ownLine);
    return { type, reason, confidence, x, y: bottom - h, w: width, h };
  };
  const inArea = (type: SuggestedFieldType, c: Box, reason: DetectReason, confidence: number): Proposal => {
    const inset = 2;
    const w = Math.min(c.w - inset * 2, MAX_WIDTH[type]);
    const room = c.h - inset * 2;
    // TEXT fills the area (a minutes box); other types stand at its bottom at up to 1.5× their default height.
    const h = type === 'CHECKBOX' ? Math.min(room, CHECKBOX_MAX) : type === 'TEXT' ? Math.min(room, 400) : Math.min(room, sizeOf(type).height * 1.5);
    return { type, reason, confidence, x: c.x + inset, y: c.y + c.h - inset - h, w, h };
  };

  // 1 — label patterns.
  for (const [li, line] of lines.entries()) {
    const textWords = line.filter((w) => !w.underline && !w.glyph).length;
    for (let i = 0; i < line.length; i += 1) {
      const rule = labelRuleAt(line, i);
      if (rule === null) continue;
      const span = rule.words.length;
      const first = line[i] as Word;
      const last = line[i + span - 1] as Word;
      const labelBox: Box = { x: first.x, y: Math.min(first.y, last.y), w: last.x + last.w - first.x, h: Math.max(first.h, last.h) };
      const after = line[i + span];
      const type = rule.type;
      const def = sizeOf(type);
      const min = DETECT_MIN_SIZE[type];
      const reason: DetectReason = `label:${rule.label}`;
      const cx = labelBox.x + labelBox.w / 2;
      const cy = labelBox.y + labelBox.h / 2;
      const cell = shapes.areas.find((c) => contains(c, cx, cy));
      // A drawn rule starting just after the label, on its baseline.
      const ruleAfter = shapes.hRules.find(
        (r) => r.x >= labelBox.x + labelBox.w - 2 && r.x - (labelBox.x + labelBox.w) <= 48 && r.y >= labelBox.y + labelBox.h * 0.5 && r.y <= labelBox.y + labelBox.h + 6 && (after === undefined || r.x < after.x),
      );
      // An underline (or drawn rule) just above the label, overlapping it ("____" over "Name").
      let above: Box | undefined;
      let aboveLine: Word[] | null = null;
      // A "Label:" takes its value after it, never from the line above; an underline another
      // label already took is not this one's either.
      for (let lj = li - 1; lj >= 0 && above === undefined && !last.colon; lj -= 1) {
        const prior = lines[lj] ?? [];
        const top = Math.min(...prior.map((w) => w.y));
        if (labelBox.y - top > labelBox.h * 3.5) break;
        above = prior.find((w) => w.underline && !usedLines.has(w) && overlapsX(w, labelBox.x - labelBox.h, labelBox.x + labelBox.w + labelBox.h));
        aboveLine = prior;
      }
      if (above === undefined && !last.colon) {
        aboveLine = null;
        above = shapes.hRules.find((r) => r.y <= labelBox.y && labelBox.y - r.y <= labelBox.h * 1.6 && overlapsX(r, labelBox.x, labelBox.x + labelBox.w));
      }
      const onlyLabel = textWords === span;
      const formLike = last.colon || after?.underline === true || ruleAfter !== undefined || above !== undefined || cell !== undefined || onlyLabel || (LENIENT.has(type) && textWords <= SHORT_LINE_WORDS);
      if (!formLike) {
        i += span - 1;
        continue;
      }
      let p: Proposal | null = null;
      if (after?.underline === true) {
        // a — on the underline that follows.
        p = onLine(type, reason, CONFIDENCE.labelOnLine, after.x, fitWidth(type, after.w), after.y + after.h, line);
        usedLines.add(after);
      } else if (ruleAfter !== undefined) {
        // b — on the drawn line that follows.
        const width = fitWidth(type, Math.min(ruleAfter.w, after !== undefined ? after.x - GAP - ruleAfter.x : ruleAfter.w));
        p = onLine(type, reason, CONFIDENCE.labelOnLine, ruleAfter.x, width, ruleAfter.y, line);
      } else if (cell === undefined && above !== undefined && (after === undefined || textWords <= SHORT_LINE_WORDS)) {
        // c — on the line above the label.
        p = onLine(type, reason, CONFIDENCE.labelOnLine, above.x, fitWidth(type, above.w), above.y + above.h, aboveLine);
        if (aboveLine !== null) usedLines.add(above as Word);
      } else if (cell !== undefined) {
        // d — the label sits in a table cell: the empty cell to its right, else the empty rest
        // of its own cell, else the empty cell below.
        const restX = labelBox.x + labelBox.w + GAP;
        const rest: Box = { x: restX, y: cell.y, w: cell.x + cell.w - restX, h: cell.h };
        const restEmpty = rest.w - 4 >= min.width && !line.some((w) => w !== last && w.x >= restX && contains(cell, w.x + w.w / 2, w.y + w.h / 2));
        const right = emptyAreas.find((c) => Math.abs(c.x - (cell.x + cell.w)) <= 3 && Math.min(c.y + c.h, cell.y + cell.h) - Math.max(c.y, cell.y) > Math.min(c.h, cell.h) * 0.5);
        const below = emptyAreas.find((c) => Math.abs(c.y - (cell.y + cell.h)) <= 3 && Math.min(c.x + c.w, cell.x + cell.w) - Math.max(c.x, cell.x) > Math.min(c.w, cell.w) * 0.5);
        if (right !== undefined && right.w - 4 >= min.width) p = inArea(type, right, reason, CONFIDENCE.labelInCell);
        else if (restEmpty && rest.h - 4 >= min.height) p = inArea(type, rest, reason, CONFIDENCE.labelInCell);
        else if (below !== undefined && below.w - 4 >= min.width) p = inArea(type, below, reason, CONFIDENCE.labelInCell);
      }
      if (p === null && cell === undefined) {
        // e — right after the label, up to the next word (or the page margin).
        const x = labelBox.x + labelBox.w + GAP;
        const limit = after !== undefined ? after.x - GAP : vw - margin;
        const width = Math.min(def.width, limit - x);
        if (width >= min.width) {
          p = onLine(type, reason, CONFIDENCE.labelBeside, x, width, labelBox.y + labelBox.h + 2, line);
        } else if (last.colon) {
          // f — below a "Label:" with no room beside it, when the space under it is empty.
          const top = labelBox.y + labelBox.h + 2;
          const w = Math.min(def.width, vw - margin - labelBox.x);
          const room: Box = { x: labelBox.x, y: top, w, h: def.height };
          if (w >= min.width && !words.some((o) => intersects(o, room))) p = { type, reason, confidence: CONFIDENCE.labelBelow, ...room };
        }
      }
      if (p !== null) out.push(rule.type === 'SIGN_DATE' && rule.label === 'Date' ? { ...p, dateLabel: true } : p);
      i += span - 1;
    }
  }

  // 2 — checkbox glyphs (☐ □): a square at the glyph.
  for (const w of words) {
    if (!w.glyph) continue;
    const side = Math.max(CHECKBOX_MIN, Math.min(CHECKBOX_MAX, Math.max(w.h, w.w)));
    out.push({ type: 'CHECKBOX', reason: 'checkbox_glyph', confidence: CONFIDENCE.checkbox_glyph, x: w.x + w.w / 2 - side / 2, y: w.y + w.h / 2 - side / 2, w: side, h: side });
  }

  // 3 — underscore runs no label used: TEXT sized to the run.
  for (const line of lines) {
    for (const w of line) {
      if (!w.underline || usedLines.has(w) || w.w < 24) continue;
      out.push(onLine('TEXT', 'underscore_line', CONFIDENCE.underscore_line, w.x, Math.min(w.w, MAX_WIDTH.TEXT), w.y + w.h, line));
    }
  }

  // 4 — empty boxes and table cells: CHECKBOX when small and square, else TEXT.
  for (const c of emptyAreas) {
    if (isSquare(c)) {
      out.push({ type: 'CHECKBOX', reason: c.kind, confidence: CONFIDENCE[c.kind], x: c.x, y: c.y, w: c.w, h: c.h });
      continue;
    }
    if (c.w - 4 < DETECT_MIN_SIZE.TEXT.width || c.h - 4 < DETECT_MIN_SIZE.TEXT.height) continue;
    out.push(inArea('TEXT', c, c.kind, CONFIDENCE[c.kind]));
  }

  // "Date:" is the signing date only next to a signature (same line, or within three lines).
  const signatures = out.filter((p) => p.type === 'SIGNATURE');
  for (const p of out) {
    if (p.dateLabel !== true) continue;
    const near = signatures.some((s) => Math.abs(s.y + s.h - (p.y + p.h)) <= 80);
    if (!near) p.type = 'TEXT';
  }
  return out;
}

/** The type a proposal takes on a host that may place only `allowed` (null: drop it). */
function gateType(type: SuggestedFieldType, allowed: ReadonlySet<string> | null): SuggestedFieldType | null {
  if (allowed === null || allowed.has(type)) return type;
  // A text-like label type the host lacks becomes a plain text field there.
  if ((type === 'SIGNER_NAME' || type === 'TITLE' || type === 'EMAIL' || type === 'COMPANY' || type === 'SIGN_DATE') && allowed.has('TEXT')) return 'TEXT';
  return null;
}

/**
 * P2-4 — the deterministic suggestions for one document: every page, label patterns, underscore
 * lines, empty boxes / table cells and checkbox glyphs; overlaps removed (the more confident one
 * stays); at most `limit` (the most confident first), returned in reading order (page, then top
 * to bottom, then left to right). Never throws on odd input.
 */
export function detectFields(pages: readonly DetectTextPage[], frames: readonly DetectPageFrame[], opts: DetectOptions = {}): DetectResult {
  const allowed = opts.types === undefined ? null : new Set<string>(opts.types);
  const limit = Math.max(0, opts.limit ?? DETECT_LIMIT);
  const graphicsByPage = new Map((opts.graphics ?? []).map((g) => [g.page, g]));
  const textByPage = new Map(pages.map((p) => [p.page, p]));
  const skipped: SkippedPage[] = [];
  const all: Array<DetectedField & { order: number }> = [];
  let order = 0;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const n = index + 1;
    if (!usable(frame)) continue;
    const text = textByPage.get(n) ?? { page: n, words: [] };
    const graphics = graphicsByPage.get(n);
    if (text.words.length === 0 && (graphics === undefined || graphics.rects.length === 0)) continue;
    if (rotated(frame)) {
      skipped.push({ page: n, reason: 'rotated' });
      continue;
    }
    const proposals = proposalsOfPage(text, graphics, frame).flatMap((p) => {
      const type = gateType(p.type, allowed);
      return type === null || !isFieldTypeOn('suggestion', type) ? [] : [{ ...p, type }];
    });
    // Dedupe: the most confident first; a box mostly covering a kept one is dropped.
    proposals.sort((a, b) => b.confidence - a.confidence || a.y - b.y || a.x - b.x);
    const kept: Proposal[] = [];
    for (const p of proposals) {
      if (kept.some((k) => overlapArea(k, p) > Math.min(area(k), area(p)) * 0.3)) continue;
      kept.push(p);
    }
    for (const p of kept) {
      const f = toFieldFrame(p, DETECT_MIN_SIZE[p.type], frame);
      if (f === null) continue;
      all.push({ type: p.type, page: n, page_number: index, ...f, reason: p.reason, confidence: p.confidence, order: (order += 1) });
    }
  }
  const chosen = [...all].sort((a, b) => b.confidence - a.confidence || a.order - b.order).slice(0, limit);
  const suggestions = chosen
    .sort((a, b) => a.page - b.page || b.y + b.height - (a.y + a.height) || a.x - b.x)
    .map((s): DetectedField => ({ type: s.type, page: s.page, page_number: s.page_number, x: s.x, y: s.y, width: s.width, height: s.height, reason: s.reason, confidence: s.confidence }));
  return { suggestions, skipped_pages: skipped };
}

// ── Editors: which suggestions are still pending ────────────────────────────────

/** A suggestion as an editor holds it (any frame, as long as fields use the same one). */
export interface PendingSuggestionLike {
  readonly id: string;
  readonly type: string;
  readonly docId: string;
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PlacedBoxLike {
  readonly docId: string;
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The suggestions an editor still shows as ghosts (web and mobile share this rule): a type the
 * host's palette offers, not dismissed, and not already covered by a placed field (so an
 * accepted ghost disappears, and comes back if the accept is undone).
 */
export function pendingSuggestions<S extends PendingSuggestionLike>(
  suggestions: readonly S[],
  fields: readonly PlacedBoxLike[],
  opts: { readonly types: readonly string[]; readonly dismissed: ReadonlySet<string> },
): S[] {
  const types = new Set(opts.types);
  return suggestions.filter((s) => {
    if (!types.has(s.type) || opts.dismissed.has(s.id)) return false;
    const sb = { x: s.x, y: s.y, w: s.width, h: s.height };
    return !fields.some((f) => f.docId === s.docId && f.page === s.page && overlapArea(sb, { x: f.x, y: f.y, w: f.width, h: f.height }) > area(sb) * 0.5);
  });
}

/** The plain-language reason a ghost field was suggested (editor tooltips and a11y labels). */
export function suggestionReasonText(reason: string): string {
  if (reason.startsWith('label:')) return `next to the label “${reason.slice(6)}”`;
  switch (reason) {
    case 'underscore_line':
      return 'on an underscore line';
    case 'empty_box':
      return 'in an empty box';
    case 'empty_cell':
      return 'in an empty table cell';
    case 'checkbox_glyph':
      return 'on a check box symbol';
    default:
      return 'found in the document';
  }
}

/** Whether `v` reads as a suggestion type (the catalog's `suggestion` surface). */
export const isSuggestedFieldType = (v: unknown): v is SuggestedFieldType => isFieldTypeOn('suggestion', v);
