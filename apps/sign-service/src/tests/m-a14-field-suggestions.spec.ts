import 'reflect-metadata';

import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { DocumentTextLayerService, type TextLayerPage, type TextLayerWord } from '../app/text-layer/document-text-layer.service.js';
import { type PageFrame, SUGGESTED_SIZE, SUGGESTION_LIMIT, suggestFields } from '../app/text-layer/field-suggestions.js';
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
