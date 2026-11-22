import 'reflect-metadata';

import { PDFDocument, PDFHexString, PDFName, StandardFonts, beginText, degrees, endText, moveText, rgb, setFontAndSize, showText, type PDFPage, type PDFRef } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { DocumentTextLayerService, type TextLayerPage, type TextLayerWord } from '../app/text-layer/document-text-layer.service.js';
import { DETECT_LIMIT, type PageFrame, SUGGESTED_SIZE, SUGGESTION_LIMIT, detectFields, suggestFields } from '../app/text-layer/field-suggestions.js';
import { FieldSuggestionsService } from '../app/text-layer/field-suggestions.service.js';

// Aramo Sign Mobile M-A14 R-3 / §2 — "Auto suggest fields" (Option A, deterministic). Fixture
// word boxes for several layouts, the field frame conversion (points, origin bottom-left,
// page_number 0-based), the cap, and the empty-list-on-failure rule.

const W = 612;
const H = 792;
const frame = (over: Partial<PageFrame> = {}): PageFrame => ({ width: W, height: H, view: { x: 0, y: 0, width: W, height: H }, rotation: 0, ...over });
// A word given in points, top-left origin (yTop = the top of the glyph box; bottom = baseline).
const w = (t: string, x: number, yTop: number, width: number, h = 12): TextLayerWord => ({ t, x: x / W, y: yTop / H, w: width / W, h: h / H });
const page = (n: number, words: TextLayerWord[]): TextLayerPage => ({ page: n, words });
// A paragraph of body text (never a label).
const prose = (yTop: number): TextLayerWord[] =>
  'The parties agree to the terms set out in this agreement and its schedules'.split(' ').map((t, i) => w(t, 72 + i * 34, yTop, 30));

describe('M-A14 R-3 — detection on fixture word boxes', () => {
  it('"Signature: ____  Date: ____" — boxes sit on each underline, in the field frame', () => {
    const p = page(1, [...prose(100), w('Signature:', 72, 700, 60), w('______________________', 136, 700, 200), w('Date:', 360, 700, 30), w('____________', 394, 700, 120)]);
    const out = suggestFields([p], [frame()]);
    expect(out.map((s) => s.type)).toEqual(['SIGNATURE', 'SIGN_DATE']);
    const [sig, date] = out;
    // Underline bottom (baseline) at 712 from the top → y = 792 - 712 = 80 from the bottom.
    expect(sig).toMatchObject({ page: 1, page_number: 0, x: 136, y: 80, width: 200 });
    expect(sig?.height).toBe(SUGGESTED_SIZE.SIGNATURE.height);
    expect(date).toMatchObject({ page: 1, page_number: 0, x: 394, y: 80, width: 120, height: SUGGESTED_SIZE.SIGN_DATE.height });
  });

  it('a label under its underline ("________" over "Signature") uses the underline above', () => {
    const p = page(1, [w('______________________', 72, 600, 220), w('Signature', 72, 616, 56), w('Date', 340, 616, 26), w('____________', 340, 600, 120)]);
    const out = suggestFields([p], [frame()]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: 'SIGNATURE', x: 72, y: 792 - 612, width: 220 });
    expect(out[1]).toMatchObject({ type: 'SIGN_DATE', x: 340, y: 792 - 612, width: 120 });
  });

  it('"Signed by" with no underline — a default-size box right after the label, on its baseline', () => {
    const p = page(2, [w('Signed', 72, 500, 38), w('by', 113, 500, 14)]);
    const out = suggestFields([page(1, prose(100)), p], [frame(), frame()]);
    expect(out).toEqual([{ type: 'SIGNATURE', page: 2, page_number: 1, x: 131, y: 792 - 514, width: 230, height: 50 }]);
  });

  it('"Sign here" and "Date signed" are labels; the height shrinks below the text above', () => {
    const p = page(1, [w('Heading', 72, 660, 80), w('Sign', 72, 690, 24), w('here', 99, 690, 26), w('Date', 330, 690, 26), w('signed', 359, 690, 36)]);
    const out = suggestFields([p], [frame()]);
    expect(out.map((s) => s.type)).toEqual(['SIGNATURE', 'SIGN_DATE']);
    // The heading's bottom is 672; the box bottom 704 → at most 704 - 672 - 2 = 30 points tall.
    expect(out[0]?.height).toBe(30);
    expect(out[1]?.x).toBe(399);
  });

  it('prose that mentions a signature or a date is not a label', () => {
    const sentence = 'By adding a signature the parties confirm the date of this agreement and its terms in full'.split(' ').map((t, i) => w(t, 40 + i * 30, 300, 26));
    expect(suggestFields([page(1, sentence)], [frame()])).toEqual([]);
  });

  it('no labels at all → []; an image-only page → []', () => {
    expect(suggestFields([page(1, prose(100))], [frame()])).toEqual([]);
    expect(suggestFields([page(1, [])], [frame()])).toEqual([]);
    expect(suggestFields([], [])).toEqual([]);
  });

  it('a date on a page without a signature (a letter date) is not suggested', () => {
    const letter = page(1, [w('Date:', 72, 80, 30), w('1', 106, 80, 10), w('November', 120, 80, 60)]);
    const block = page(3, [w('Signature:', 72, 700, 60), w('____________________', 136, 700, 200)]);
    const out = suggestFields([letter, page(2, prose(100)), block], [frame(), frame(), frame()]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'SIGNATURE', page: 3, page_number: 2 });
  });

  it(`at most ${SUGGESTION_LIMIT}, taken from the LAST pages first, returned in page order`, () => {
    const pages = [1, 2, 3, 4, 5].map((n) => page(n, [w('Signature:', 72, 700, 60), w('_______________', 136, 700, 180), w('Date:', 360, 700, 30), w('_________', 394, 700, 110)]));
    const out = suggestFields(pages, pages.map(() => frame()));
    expect(out).toHaveLength(SUGGESTION_LIMIT);
    expect(out.map((s) => s.page)).toEqual([3, 3, 4, 4, 5, 5]);
  });

  it('overlapping proposals are deduped ("Signature" next to "Signed by" on one underline)', () => {
    const p = page(1, [w('Signature', 72, 616, 56), w('______________________', 72, 600, 220), w('Signed', 140, 616, 36), w('by', 180, 616, 14)]);
    const out = suggestFields([p], [frame()]);
    expect(out).toHaveLength(1);
  });

  it('"Signature:____" in one word is split into the label and the underline', () => {
    const out = suggestFields([page(1, [w('Signature:__________', 72, 700, 200)])], [frame()]);
    expect(out).toHaveLength(1);
    // The underline starts after the 10 label characters: 72 + 10/20 × 200 = 172.
    expect(out[0]).toMatchObject({ x: 172, width: 100 });
  });

  it('a rotated page gets nothing; a crop box offsets the frame; boxes stay inside the media box', () => {
    const p = page(1, [w('Signature:', 72, 700, 60), w('____________', 136, 700, 200)]);
    expect(suggestFields([p], [frame({ rotation: 90 })])).toEqual([]);
    const cropped = frame({ view: { x: 10, y: 20, width: W, height: H } });
    expect(suggestFields([p], [cropped])[0]).toMatchObject({ x: 146, y: 100 });
    // A label at the right edge leaves no room → nothing; a box never exceeds the page.
    expect(suggestFields([page(1, [w('Signature', 560, 700, 40)])], [frame()])).toEqual([]);
    for (const s of suggestFields([p], [frame()])) {
      expect(s.x + s.width).toBeLessThanOrEqual(W);
      expect(s.y + s.height).toBeLessThanOrEqual(H);
    }
  });

  it('is deterministic', () => {
    const p = page(1, [w('Signature:', 72, 700, 60), w('____________', 136, 700, 200), w('Date:', 360, 700, 30)]);
    expect(suggestFields([p], [frame()])).toEqual(suggestFields([p], [frame()]));
  });
});

describe('M-A14 R-3 — FieldSuggestionsService', () => {
  async function signaturePdf(rotate = 0): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([612, 792]).drawText('The parties agree to the terms below.', { x: 72, y: 700, size: 12, font });
    const last = pdf.addPage([612, 792]);
    last.drawText('Signature: ______________________', { x: 72, y: 120, size: 12, font });
    if (rotate !== 0) last.setRotation(degrees(rotate));
    return pdf.save();
  }

  it('a real PDF: the suggestion sits on the underline of the last page, on its baseline (points, bottom-left)', async () => {
    const svc = new FieldSuggestionsService(new DocumentTextLayerService());
    const bytes = await signaturePdf();
    const load = vi.fn(async () => bytes);
    const { suggestions } = await svc.suggest('doc-1', 'v1', load);
    expect(suggestions).toHaveLength(1);
    const [s] = suggestions;
    expect(s).toMatchObject({ type: 'SIGNATURE', page: 2, page_number: 1 });
    // Text drawn at baseline y = 120 → the box's lower edge is at the baseline.
    expect(Math.abs((s?.y ?? 0) - 120)).toBeLessThan(2);
    // After "Signature: " (Helvetica 12) — well right of the label's start, inside the page.
    expect(s?.x ?? 0).toBeGreaterThan(120);
    expect((s?.x ?? 0) + (s?.width ?? 0)).toBeLessThanOrEqual(612);
    expect(load).toHaveBeenCalledTimes(1);
    // Cached per version: no second byte fetch.
    await svc.suggest('doc-1', 'v1', load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a rotated signature page → []', async () => {
    const svc = new FieldSuggestionsService(new DocumentTextLayerService());
    const bytes = await signaturePdf(90);
    expect(await svc.suggest('doc-2', 'v1', async () => bytes)).toEqual({ suggestions: [] });
  });

  it('any failure is an empty list, and no text is logged', async () => {
    const layer = new DocumentTextLayerService();
    layer.extract = async () => [{ page: 1, words: [{ t: 'Signature:', x: 0.1, y: 0.8, w: 0.1, h: 0.02 }] }];
    const svc = new FieldSuggestionsService(layer);
    svc.readFrames = async () => {
      throw new Error('Signature: secret-content');
    };
    const warn = vi.spyOn((svc as unknown as { log: { warn: (m: string) => void } }).log, 'warn').mockImplementation(() => undefined);
    expect(await svc.suggest('doc-3', 'v1', async () => new Uint8Array([1]))).toEqual({ suggestions: [] });
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('secret');
    // A load failure too.
    expect(await new FieldSuggestionsService(new DocumentTextLayerService()).suggest('doc-4', 'v1', async () => {
      throw new Error('storage down');
    })).toEqual({ suggestions: [] });
    // Not a PDF → an empty text layer → [].
    expect(await new FieldSuggestionsService(new DocumentTextLayerService()).suggest('doc-5', 'v1', async () => new TextEncoder().encode('not a pdf'))).toEqual({ suggestions: [] });
  });
});

// FIELD-PARITY-1 §5 P2-4 — `detect: 'all'`: the shared detector (@aramo/sign-fields detectFields)
// over the real text layer AND the drawn rectangles of pdf-lib-generated PDFs: underscore lines,
// empty boxes, a ruled table, label patterns and ☐ glyphs, several pages, a rotated page skipped,
// overlaps removed, the limit. The default (no mode) answer stays the M-A14 one.
describe('FIELD-PARITY-1 P2-4 — FieldSuggestionsService detect=all on real PDFs', () => {
  // Helvetica with one code remapped to the glyph name uni2610, so the text layer reads "☐".
  function boxGlyphFont(doc: PDFDocument): PDFRef {
    const enc = doc.context.obj({ Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [128, PDFName.of('uni2610')] });
    return doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: enc }));
  }
  function drawGlyph(page: PDFPage, x: number, y: number): void {
    page.pushOperators(beginText(), setFontAndSize('FBox', 12), moveText(x, y), showText(PDFHexString.of('80')), endText());
  }

  async function formPdf(): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const glyphs = boxGlyphFont(pdf);
    const black = rgb(0, 0, 0);
    // Page 1 — labels, an underscore line, a drawn box, a small square, ☐ glyphs.
    const p1 = pdf.addPage([612, 792]);
    p1.node.setFontDictionary(PDFName.of('FBox'), glyphs);
    p1.drawText('Name: ____________________', { x: 72, y: 720, size: 12, font });
    p1.drawText('Title:', { x: 72, y: 690, size: 12, font });
    p1.drawText('Email:', { x: 72, y: 660, size: 12, font });
    p1.drawText('Reference ______________________', { x: 72, y: 620, size: 12, font });
    p1.drawText('Notes', { x: 72, y: 585, size: 12, font });
    p1.drawRectangle({ x: 72, y: 480, width: 400, height: 90, borderColor: black, borderWidth: 1 });
    p1.drawRectangle({ x: 72, y: 440, width: 12, height: 12, borderColor: black, borderWidth: 1 });
    p1.drawText('I agree', { x: 90, y: 442, size: 12, font });
    drawGlyph(p1, 72, 410);
    p1.drawText('Yes', { x: 90, y: 410, size: 12, font });
    // Page 2 — a ruled attendee table (thin filled rules, as Word exports) and a signature block.
    const p2 = pdf.addPage([612, 792]);
    for (const y of [700, 670, 640, 610]) p2.drawRectangle({ x: 72, y, width: 400, height: 0.75, color: black });
    for (const x of [72, 222, 472]) p2.drawRectangle({ x, y: 610, width: 0.75, height: 90.75, color: black });
    p2.drawText('Company', { x: 80, y: 680, size: 12, font });
    p2.drawText('Signature: ______________________', { x: 72, y: 200, size: 12, font });
    p2.drawText('Date: ____________', { x: 360, y: 200, size: 12, font });
    // Page 3 — rotated: skipped with a reason.
    const p3 = pdf.addPage([612, 792]);
    p3.drawText('Signature: ______________________', { x: 72, y: 200, size: 12, font });
    p3.setRotation(degrees(90));
    return pdf.save();
  }

  it('finds labels, lines, boxes, cells and glyphs with a type, a size and a reason', async () => {
    const svc = new FieldSuggestionsService(new DocumentTextLayerService());
    const bytes = await formPdf();
    const out = await svc.suggest('doc-all', 'v1', async () => bytes, 'all');
    const at = (page: number, reason: string) => out.suggestions.filter((s) => s.page === page && s.reason === reason);
    // Labels.
    expect(at(1, 'label:Name')).toEqual([expect.objectContaining({ type: 'SIGNER_NAME', page_number: 0 })]);
    expect(at(1, 'label:Title')).toEqual([expect.objectContaining({ type: 'TITLE' })]);
    expect(at(1, 'label:Email')).toEqual([expect.objectContaining({ type: 'EMAIL' })]);
    // The Name label's field sits on its underline (baseline 720), right of the label.
    const name = at(1, 'label:Name')[0];
    expect(Math.abs((name?.y ?? 0) - 720)).toBeLessThan(3);
    expect(name?.x ?? 0).toBeGreaterThan(100);
    // A bare underscore line (after "Reference", not a label) → TEXT sized to the run.
    const line = at(1, 'underscore_line');
    expect(line).toHaveLength(1);
    expect(line[0]).toMatchObject({ type: 'TEXT' });
    expect(line[0]?.width ?? 0).toBeGreaterThan(100);
    // The empty drawn box → TEXT filling it; the 12pt square → CHECKBOX; the ☐ glyph → CHECKBOX.
    const boxes = at(1, 'empty_box');
    expect(boxes.map((b) => b.type).sort()).toEqual(['CHECKBOX', 'TEXT']);
    // (The drawn boxes are read at 0..1 of the page to 4 places, so within 0.1pt.)
    const near = (b: { x: number; y: number; width: number; height: number } | undefined, e: [number, number, number, number]) =>
      [b?.x ?? 0, b?.y ?? 0, b?.width ?? 0, b?.height ?? 0].forEach((v, i) => expect(Math.abs(v - e[i]!)).toBeLessThan(0.1));
    near(boxes.find((b) => b.type === 'TEXT'), [74, 482, 396, 86]);
    near(boxes.find((b) => b.type === 'CHECKBOX'), [72, 440, 12, 12]);
    expect(at(1, 'checkbox_glyph')).toEqual([expect.objectContaining({ type: 'CHECKBOX' })]);
    // Page 2 — the "Company" cell fills the empty cell to its right; the other cells are empty.
    expect(at(2, 'label:Company')).toEqual([expect.objectContaining({ type: 'COMPANY' })]);
    expect(at(2, 'label:Company')[0]?.x ?? 0).toBeGreaterThan(222);
    expect(at(2, 'empty_cell')).toHaveLength(4);
    expect(at(2, 'label:Signature')).toEqual([expect.objectContaining({ type: 'SIGNATURE' })]);
    // "Date:" next to a signature is the signing date.
    expect(at(2, 'label:Date')).toEqual([expect.objectContaining({ type: 'SIGN_DATE' })]);
    // Page 3 is rotated: nothing, and it is reported.
    expect(out.suggestions.some((s) => s.page === 3)).toBe(false);
    expect(out.skipped_pages).toEqual([{ page: 3, reason: 'rotated' }]);
    // No two suggestions on a page overlap; every box is inside its page; confidence is set.
    for (const a of out.suggestions) {
      expect(a.x + a.width).toBeLessThanOrEqual(612);
      expect(a.y + a.height).toBeLessThanOrEqual(792);
      expect(a.confidence).toBeGreaterThan(0);
      for (const b of out.suggestions) {
        if (a === b || a.page !== b.page) continue;
        const ix = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const iy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(ix > 0 && iy > 0 && ix * iy > Math.min(a.width * a.height, b.width * b.height) * 0.3).toBe(false);
      }
    }
  });

  it('the default answer of the same PDF is still the M-A14 one (SIGNATURE / SIGN_DATE only)', async () => {
    const svc = new FieldSuggestionsService(new DocumentTextLayerService());
    const bytes = await formPdf();
    const out = await svc.suggest('doc-default', 'v1', async () => bytes);
    expect(Object.keys(out)).toEqual(['suggestions']);
    expect(out.suggestions.map((s) => s.type)).toEqual(['SIGNATURE', 'SIGN_DATE']);
    expect(out.suggestions.every((s) => !('reason' in s))).toBe(true);
  });

  it(`raises the limit to ${DETECT_LIMIT} per document, across every page`, async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let p = 0; p < 4; p += 1) {
      const page = pdf.addPage([612, 792]);
      for (let i = 0; i < 20; i += 1) page.drawText('__________', { x: 72, y: 760 - i * 36, size: 12, font });
    }
    const bytes = await pdf.save();
    const svc = new FieldSuggestionsService(new DocumentTextLayerService());
    const out = await svc.suggest('doc-many', 'v1', async () => bytes, 'all');
    expect(out.suggestions).toHaveLength(80);
    expect(new Set(out.suggestions.map((s) => s.page))).toEqual(new Set([1, 2, 3, 4]));
    expect(detectFields([], [], { limit: 3 }).suggestions).toEqual([]);
  });

  it('a drawing that cannot be read leaves the text rules; any other failure is an empty answer', async () => {
    const svc = new FieldSuggestionsService(new DocumentTextLayerService());
    svc.readGraphics = async () => {
      throw new Error('broken drawing');
    };
    const bytes = await formPdf();
    const out = await svc.suggest('doc-nodraw', 'v1', async () => bytes, 'all');
    expect(out.suggestions.some((s) => s.reason === 'label:Name')).toBe(true);
    expect(out.suggestions.some((s) => s.reason === 'empty_box')).toBe(false);
    const failing = new FieldSuggestionsService(new DocumentTextLayerService());
    expect(await failing.suggest('doc-x', 'v1', async () => {
      throw new Error('storage down');
    }, 'all')).toEqual({ suggestions: [], skipped_pages: [] });
  });
});
