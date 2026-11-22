// FIELD-PARITY-1 P2-4 — the deterministic detector on fixture word boxes and drawn rectangles
// (runs under vitest and mobile Jest: globals only). The same detector over real pdf-lib PDFs is
// apps/sign-service/src/tests/m-a14-field-suggestions.spec.ts.
import {
  DETECT_LIMIT,
  detectFields,
  fieldTypesFor,
  pendingSuggestions,
  suggestSignatureBlock,
  suggestionReasonText,
  type DetectPageFrame,
  type DetectRect,
  type DetectWord,
} from '../index.js';

const W = 612;
const H = 792;
const frame = (over: Partial<DetectPageFrame> = {}): DetectPageFrame => ({ width: W, height: H, view: { x: 0, y: 0, width: W, height: H }, rotation: 0, ...over });
// A word in points, top-left origin (yTop = top of the glyph box).
const w = (t: string, x: number, yTop: number, width: number, h = 12): DetectWord => ({ t, x: x / W, y: yTop / H, w: width / W, h: h / H });
// A drawn shape in points, top-left origin.
const r = (x: number, y: number, width: number, height: number, stroke = true): DetectRect => ({ x: x / W, y: y / H, w: width / W, h: height / H, stroke, fill: !stroke });
const prose = (yTop: number): DetectWord[] => 'The parties agree to the terms set out in this agreement and its schedules'.split(' ').map((t, i) => w(t, 72 + i * 34, yTop, 30));
const page = (n: number, words: DetectWord[]) => ({ page: n, words });

describe('detectFields — label patterns', () => {
  it('"Name: ____" puts SIGNER_NAME on the underline; "Title:" beside the label; reasons name the label', () => {
    const p = page(1, [...prose(100), w('Name:', 72, 300, 34), w('____________________', 110, 300, 180), w('Title:', 72, 340, 30)]);
    const { suggestions } = detectFields([p], [frame()]);
    const name = suggestions.find((s) => s.reason === 'label:Name');
    expect(name).toMatchObject({ type: 'SIGNER_NAME', page: 1, page_number: 0, x: 110, width: 180, y: 792 - 312 });
    const title = suggestions.find((s) => s.reason === 'label:Title');
    expect(title).toMatchObject({ type: 'TITLE', x: 106, width: 200 });
    // The underline under "Name:" is not also a TEXT suggestion.
    expect(suggestions.filter((s) => s.reason === 'underscore_line')).toEqual([]);
  });

  it('Email, Company, Printed name, Initials and Signature labels map to their types', () => {
    const p = page(1, [
      w('Email:', 72, 100, 34),
      w('Company:', 72, 140, 52),
      w('Printed', 72, 180, 40),
      w('name:', 115, 180, 30),
      w('Initials:', 72, 220, 44),
      w('Signature:', 72, 300, 60),
    ]);
    const types = Object.fromEntries(detectFields([p], [frame()]).suggestions.map((s) => [s.reason, s.type]));
    expect(types).toEqual({ 'label:Email': 'EMAIL', 'label:Company': 'COMPANY', 'label:Printed name': 'SIGNER_NAME', 'label:Initials': 'INITIALS', 'label:Signature': 'SIGNATURE' });
  });

  it('"Date:" is SIGN_DATE next to a signature, TEXT elsewhere', () => {
    const p = page(1, [w('Date:', 72, 100, 30), w('Signature:', 72, 600, 60), w('______________________', 136, 600, 200), w('Date:', 360, 600, 30), w('____________', 394, 600, 120)]);
    const out = detectFields([p], [frame()]).suggestions;
    const dates = out.filter((s) => s.reason === 'label:Date').sort((a, b) => b.y - a.y);
    expect(dates.map((s) => s.type)).toEqual(['TEXT', 'SIGN_DATE']);
  });

  it('prose that merely mentions a name or a title is not a label', () => {
    const sentence = 'The name and title of the company are set out in the schedule below for reference'.split(' ').map((t, i) => w(t, 40 + i * 30, 300, 26));
    expect(detectFields([page(1, sentence)], [frame()]).suggestions).toEqual([]);
  });
});

describe('detectFields — lines, glyphs, boxes and cells', () => {
  it('an underscore run with no label is a TEXT field sized to the run', () => {
    const out = detectFields([page(1, [...prose(100), w('________________', 200, 400, 160)])], [frame()]).suggestions;
    expect(out).toEqual([{ type: 'TEXT', page: 1, page_number: 0, x: 200, y: 792 - 412, width: 160, height: 22, reason: 'underscore_line', confidence: 0.5 }]);
  });

  it('☐ and □ glyphs are CHECKBOX squares at the glyph, also inside a word ("☐Yes")', () => {
    const out = detectFields([page(1, [w('☐', 72, 200, 10, 10), w('□Yes', 72, 240, 30, 12)])], [frame()]).suggestions;
    expect(out.map((s) => [s.type, s.reason])).toEqual([
      ['CHECKBOX', 'checkbox_glyph'],
      ['CHECKBOX', 'checkbox_glyph'],
    ]);
    expect(out[0]).toMatchObject({ width: 10, height: 10 });
  });

  it('an empty drawn box is TEXT, a small square box is CHECKBOX, a box with text is nothing', () => {
    const graphics = [{ page: 1, rects: [r(72, 100, 300, 60), r(72, 200, 12, 12), r(72, 300, 200, 40)] }];
    const words = [w('Already', 80, 310, 40)];
    const out = detectFields([page(1, words)], [frame()], { graphics }).suggestions;
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: 'TEXT', reason: 'empty_box', x: 74, width: 296, height: 56 });
    expect(out[1]).toMatchObject({ type: 'CHECKBOX', reason: 'empty_box', x: 72, width: 12, height: 12 });
  });

  it('a ruled table: a label cell fills the empty cell to its right; other empty cells are TEXT', () => {
    // 2 columns (72..200, 200..500) × 3 rows (100..130..160..190), drawn as thin filled rules.
    const rules: DetectRect[] = [];
    for (const y of [100, 130, 160, 190]) rules.push(r(72, y, 428, 0.75, false));
    for (const x of [72, 200, 500]) rules.push(r(x, 100, 0.75, 90, false));
    const words = [w('Name', 80, 108, 30), w('Attendee', 80, 138, 50)];
    const out = detectFields([page(1, words)], [frame()], { graphics: [{ page: 1, rects: rules }] }).suggestions;
    const byReason = out.map((s) => `${s.type}:${s.reason}:${Math.round(s.x)}:${Math.round(792 - s.y - s.height)}`);
    // Row 1: "Name" → SIGNER_NAME in the right cell. Row 2: "Attendee" is not a label → its
    // right cell is an empty cell. Row 3: two empty cells.
    expect(byReason).toEqual(['SIGNER_NAME:label:Name:202:102', 'TEXT:empty_cell:202:132', 'TEXT:empty_cell:74:162', 'TEXT:empty_cell:202:162']);
  });

  it('a page-sized border frame is never a box; only the innermost areas count', () => {
    const graphics = [{ page: 1, rects: [r(20, 20, 572, 752), r(100, 100, 200, 40)] }];
    const out = detectFields([page(1, [])], [frame()], { graphics }).suggestions;
    expect(out.map((s) => s.reason)).toEqual(['empty_box']);
  });
});

describe('detectFields — pages, dedupe, limit, host types', () => {
  it('covers every page; a rotated page gets none and is reported', () => {
    const p1 = page(1, [w('Name:', 72, 100, 34)]);
    const p2 = page(2, [w('Signature:', 72, 100, 60)]);
    const p3 = page(3, [w('Title:', 72, 100, 30)]);
    const out = detectFields([p1, p2, p3], [frame(), frame({ rotation: 90 }), frame()]);
    expect(out.suggestions.map((s) => [s.page, s.type])).toEqual([
      [1, 'SIGNER_NAME'],
      [3, 'TITLE'],
    ]);
    expect(out.skipped_pages).toEqual([{ page: 2, reason: 'rotated' }]);
  });

  it('overlapping suggestions are removed, the more confident one stays', () => {
    // A glyph inside an empty box: the box is not empty (the glyph is text), so only the glyph.
    const graphics = [{ page: 1, rects: [r(70, 198, 14, 14)] }];
    const out = detectFields([page(1, [w('☐', 72, 200, 10, 10)])], [frame()], { graphics }).suggestions;
    expect(out.map((s) => s.reason)).toEqual(['checkbox_glyph']);
    // Two underlines on top of each other read as one.
    const twice = detectFields([page(1, [w('__________', 100, 300, 100), w('__________', 101, 301, 100)])], [frame()]).suggestions;
    expect(twice).toHaveLength(1);
  });

  it('the limit keeps the most confident (default DETECT_LIMIT)', () => {
    expect(DETECT_LIMIT).toBe(300);
    const words: DetectWord[] = [];
    for (let i = 0; i < 20; i += 1) words.push(w('__________', 72, 40 + i * 30, 100));
    words.push(w('Signature:', 300, 40, 60));
    const out = detectFields([page(1, words)], [frame()], { limit: 3 }).suggestions;
    expect(out).toHaveLength(3);
    expect(out.some((s) => s.type === 'SIGNATURE')).toBe(true);
  });

  it('on a host without the profile types, a Title label becomes TEXT; a type the host lacks is dropped', () => {
    const p = page(1, [w('Title:', 72, 100, 30), w('☐', 72, 200, 10, 10)]);
    const out = detectFields([p], [frame()], { types: ['SIGNATURE', 'INITIALS', 'SIGN_DATE', 'SIGNER_NAME', 'TEXT', 'CHECKBOX'] }).suggestions;
    expect(out.map((s) => [s.type, s.reason])).toEqual([
      ['TEXT', 'label:Title'],
      ['CHECKBOX', 'checkbox_glyph'],
    ]);
    const noBox = detectFields([p], [frame()], { types: ['TEXT'] }).suggestions;
    expect(noBox.map((s) => s.type)).toEqual(['TEXT']);
    // FIELD-PARITY-1 P3 T-1 — a fixed form now takes the profile types: a Title label stays TITLE.
    expect(detectFields([p], [frame()], { types: fieldTypesFor('template_fixed_form') }).suggestions.map((s) => s.type)).toEqual(['TITLE', 'CHECKBOX']);
  });

  it('never throws on odd input (no frame, empty view, no words)', () => {
    expect(detectFields([page(1, [w('Name:', 1, 1, 1)])], []).suggestions).toEqual([]);
    expect(detectFields([page(1, [w('Name:', 1, 1, 1)])], [frame({ view: { x: 0, y: 0, width: 0, height: 0 } })]).suggestions).toEqual([]);
    expect(detectFields([], [frame()]).suggestions).toEqual([]);
  });
});

describe('suggestSignatureBlock (M-A14 mode, unchanged)', () => {
  it('only SIGNATURE / SIGN_DATE, only pages with a signature, at most 6', () => {
    const p = page(1, [w('Signature:', 72, 700, 60), w('______________________', 136, 700, 200), w('Name:', 72, 600, 34), w('Date:', 360, 700, 30), w('____________', 394, 700, 120)]);
    const out = suggestSignatureBlock([p, page(2, [w('Date:', 72, 100, 30)])], [frame(), frame()]);
    expect(out.map((s) => s.type)).toEqual(['SIGNATURE', 'SIGN_DATE']);
    expect(out[0]).toEqual({ type: 'SIGNATURE', page: 1, page_number: 0, x: 136, y: 80, width: 200, height: 50 });
  });
});

describe('pendingSuggestions (the editors’ ghost rule)', () => {
  const s = (id: string, type: string, x: number) => ({ id, type, docId: 'd', page: 0, x, y: 100, width: 100, height: 20 });
  it('hides a dismissed one, a type off the palette, and one a placed field covers', () => {
    const list = [s('a', 'SIGNATURE', 0), s('b', 'TITLE', 200), s('c', 'TEXT', 400), s('d', 'TEXT', 600)];
    const out = pendingSuggestions(list, [{ docId: 'd', page: 0, x: 405, y: 102, width: 100, height: 20 }], { types: ['SIGNATURE', 'TEXT'], dismissed: new Set(['d']) });
    expect(out.map((x) => x.id)).toEqual(['a']);
  });
  it('a field on another page or document does not hide it', () => {
    const out = pendingSuggestions([s('a', 'TEXT', 0)], [{ docId: 'e', page: 0, x: 0, y: 100, width: 100, height: 20 }, { docId: 'd', page: 1, x: 0, y: 100, width: 100, height: 20 }], { types: ['TEXT'], dismissed: new Set() });
    expect(out).toHaveLength(1);
  });
  it('reads every reason in plain language', () => {
    expect(suggestionReasonText('label:Title')).toBe('next to the label “Title”');
    expect(suggestionReasonText('empty_cell')).toBe('in an empty table cell');
    expect(suggestionReasonText('something_else')).toBe('found in the document');
  });
});
