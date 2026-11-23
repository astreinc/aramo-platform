import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFName, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { extractTextLayer, removeAndCoverTextTags, type PdfTextTagBox, type TextLayerPage } from '../index.js';
import { SIGNATURE_SCRIPT_FONT_BASE64 } from '../lib/fonts/signature-script.font.js';

// FIELD-PARITY-2 A-6 (ruling C-8) — a text tag's text is removed from the page content, not
// only covered. Fixtures are generated here with pdf-lib: a standard font without /Widths
// (drawText, one Tj per line, the tag in the middle of other text), an embedded TrueType font
// (Type0 / Identity-H with ToUnicode and /W), hand-written content with TJ kerning, ' and ",
// and a tag drawn inside a form XObject (cannot be removed: reported, the page unchanged).

const N = PDFName.of;

/** The tag's cover box from its drawn position (what planTextTags would hand over, roughly). */
function tagBox(font: PDFFont, size: number, line: string, tag: string, x: number, y: number, page = 0): PdfTextTagBox {
  const before = line.slice(0, line.indexOf(tag));
  const x0 = x + font.widthOfTextAtSize(before, size);
  const w = font.widthOfTextAtSize(tag, size);
  return { page_number: page, x: x0 - 1, y: y - size * 0.25 - 1, width: w + 2, height: size * 1.2 + 2, text: tag };
}

const wordsOf = (pages: TextLayerPage[], page = 1): string[] => (pages.find((p) => p.page === page)?.words ?? []).map((w) => w.t);
const joined = (pages: TextLayerPage[], page = 1): string => wordsOf(pages, page).join(' ');

/** Every word that is not (part of) a tag, with its box: must be identical before and after. */
function otherWords(pages: TextLayerPage[], page = 1) {
  return (pages.find((p) => p.page === page)?.words ?? []).filter((w) => !/[{}]/.test(w.t));
}

/**
 * "Nothing else moved", read from the text layer. The extractor apportions a run's width over
 * its characters, so a word's box inside a run that changed is approximate; but a run's first
 * word starts, and its last word ends, exactly where the glyphs are. So: the left edge of the
 * word that opens a line and the right edge of the word that closes it are unchanged.
 */
function expectEdgesKept(before: TextLayerPage[], after: TextLayerPage[], firstWords: readonly string[], lastWords: readonly string[]): void {
  const find = (pages: TextLayerPage[], t: string) => {
    const w = (pages[0]?.words ?? []).find((x) => x.t === t);
    if (w === undefined) throw new Error(`no word ${t}`);
    return w;
  };
  for (const t of firstWords) {
    expect(Math.abs(find(after, t).x - find(before, t).x), t).toBeLessThanOrEqual(0.0002);
    expect(Math.abs(find(after, t).y - find(before, t).y), t).toBeLessThanOrEqual(0.0002);
  }
  for (const t of lastWords) {
    const a = find(after, t);
    const b = find(before, t);
    expect(Math.abs(a.x + a.w - (b.x + b.w)), t).toBeLessThanOrEqual(0.0003);
  }
}

async function standardFontPdf(): Promise<{ bytes: Uint8Array; tags: PdfTextTagBox[] }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines: Array<[string, string, number]> = [
    ['Seller {{signature:seller}} on behalf of Acme', '{{signature:seller}}', 700],
    ['Buyer {{text:Buyer:required}} end', '{{text:Buyer:required}}', 660],
    ['Agree {{checkbox:Buyer:label=I agree}} done', '{{checkbox:Buyer:label=I agree}}', 620],
  ];
  const tags: PdfTextTagBox[] = [];
  for (const [line, tag, y] of lines) {
    page.drawText(line, { x: 72, y, size: 11, font });
    tags.push(tagBox(font, 11, line, tag, 72, y));
  }
  page.drawText('Untouched paragraph text stays put.', { x: 72, y: 500, size: 11, font });
  return { bytes: await doc.save({ useObjectStreams: false }), tags };
}

describe('FIELD-PARITY-2 A-6 — removeAndCoverTextTags', () => {
  it('returns the bytes unchanged when there is no tag', async () => {
    const { bytes } = await standardFontPdf();
    const out = await removeAndCoverTextTags(bytes, []);
    expect(out.bytes).toBe(bytes);
    expect(out.not_removed).toEqual([]);
  });

  it('standard font: the tags are gone from the text layer; every other word is unchanged and in place', async () => {
    const { bytes, tags } = await standardFontPdf();
    const before = await extractTextLayer(bytes);
    expect(joined(before)).toContain('{{signature:seller}}');
    const out = await removeAndCoverTextTags(bytes, tags);
    expect(out.not_removed).toEqual([]);
    const after = await extractTextLayer(out.bytes);
    const text = joined(after);
    expect(text).not.toMatch(/\{\{|\}\}|signature:seller|text:Buyer|label=I/);
    expect(text.replace(/\s+/g, ' ')).toBe('Seller on behalf of Acme Buyer end Agree done Untouched paragraph text stays put.');
    // Nothing else moved: each line starts and ends where it did; the untouched line is identical.
    expectEdgesKept(before, after, ['Seller', 'Buyer', 'Agree'], ['Acme', 'end', 'done']);
    expect(otherWords(after).filter((w) => w.y > 0.3)).toEqual(otherWords(before).filter((w) => w.y > 0.3));
    // The white cover is still drawn (fallback).
    const doc = await PDFDocument.load(out.bytes);
    expect(doc.getPage(0).node.get(N('Contents'))).toBeDefined();
  });

  it('the old content stream (which held the tag text) is not left in the file', async () => {
    const { bytes, tags } = await standardFontPdf();
    const out = await removeAndCoverTextTags(bytes, tags);
    const doc = await PDFDocument.load(out.bytes);
    // Every stream in the saved file is reachable: an orphaned original would still hold the tag.
    const pageContents = doc.getPage(0).node.get(N('Contents'));
    expect(pageContents).toBeDefined();
    const all = await extractTextLayer(out.bytes);
    expect(joined(all)).not.toContain('{{');
    expect(doc.context.enumerateIndirectObjects().length).toBeLessThan((await PDFDocument.load(bytes)).context.enumerateIndirectObjects().length + 6);
  });

  it('embedded TrueType (Type0 / Identity-H with ToUnicode): the tag is removed, the rest unchanged', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(Buffer.from(SIGNATURE_SCRIPT_FONT_BASE64, 'base64'), { subset: false });
    const page = doc.addPage([612, 792]);
    const line = 'Name {{name:Seller}} here';
    page.drawText(line, { x: 72, y: 700, size: 12, font });
    const bytes = await doc.save({ useObjectStreams: false });
    const before = await extractTextLayer(bytes);
    const out = await removeAndCoverTextTags(bytes, [tagBox(font, 12, line, '{{name:Seller}}', 72, 700)]);
    expect(out.not_removed).toEqual([]);
    const after = await extractTextLayer(out.bytes);
    expect(joined(after)).not.toContain('{{');
    expect(joined(after).replace(/\s+/g, '')).toBe('Namehere');
    expectEdgesKept(before, after, ['Name'], ['here']);
  });

  it('hand-written content: TJ with kerning, the \' and " operators, and a tag split over several operators', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = doc.embedStandardFont(StandardFonts.Helvetica);
    const key = page.node.newFontDictionary('F1', font.ref);
    const content = [
      'BT',
      `/${key.asString().slice(1)} 10 Tf 14 TL 72 700 Td`,
      '[(Pay ) -20 ({{text:Payer}}) 50 ( now)] TJ',
      "(Line two {{date:Payer}} ok) '",
      '2 0.5 (Line three {{initials:Payer}} fine) "',
      '0 -40 Td ({{sig) Tj (nature:Payer}}) Tj ( tail) Tj',
      'ET',
    ].join('\n');
    page.node.set(N('Contents'), doc.context.register(doc.context.flateStream(content)));
    const bytes = await doc.save({ useObjectStreams: false });
    const before = await extractTextLayer(bytes);
    const helv = font;
    const w = (s: string, size = 10): number => helv.widthOfTextAtSize(s, size);
    const tags: PdfTextTagBox[] = [
      { page_number: 0, x: 72 + w('Pay ') + 0.2 - 1, y: 697, width: w('{{text:Payer}}') + 2, height: 13, text: '{{text:Payer}}' },
      { page_number: 0, x: 72 + w('Line two ') - 1, y: 683, width: w('{{date:Payer}}') + 2, height: 13, text: '{{date:Payer}}' },
      // The " line has word / character spacing: the box only needs to hold most glyph centres.
      { page_number: 0, x: 72 + w('Line three ') + 20, y: 669, width: w('{{initials:Payer}}') + 60, height: 13, text: '{{initials:Payer}}' },
      { page_number: 0, x: 71, y: 629, width: w('{{signature:Payer}}') + 2, height: 13, text: '{{signature:Payer}}' },
    ];
    const out = await removeAndCoverTextTags(bytes, tags);
    expect(out.not_removed).toEqual([]);
    const after = await extractTextLayer(out.bytes);
    expect(joined(after)).not.toMatch(/\{\{|\}\}|Payer/);
    expect(joined(after).replace(/\s+/g, '')).toBe(joined(before).replace(/\s+/g, '').replace(/\{\{[^}]*\}\}/g, ''));
    expectEdgesKept(before, after, ['Pay', 'Line'], ['now', 'ok', 'fine', 'tail']);
  });

  it('text in a font this reader cannot measure does not stop a tag on another line from being removed', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = doc.embedStandardFont(StandardFonts.Helvetica);
    const helv = page.node.newFontDictionary('F1', font.ref);
    // A Type1 font with no /Widths and no standard-14 name: unmeasurable here.
    const odd = page.node.newFontDictionary('F2', doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Mystery-Regular' })));
    const content = [
      'BT',
      `/${odd.asString().slice(1)} 10 Tf 72 740 Td (Odd font line) Tj`,
      'ET',
      'BT',
      `/${helv.asString().slice(1)} 10 Tf 72 700 Td (Sign {{signature:A}} here) Tj`,
      'ET',
    ].join('\n');
    page.node.set(N('Contents'), doc.context.register(doc.context.flateStream(content)));
    const bytes = await doc.save({ useObjectStreams: false });
    const w = (t: string): number => font.widthOfTextAtSize(t, 10);
    const out = await removeAndCoverTextTags(bytes, [{ page_number: 0, x: 72 + w('Sign ') - 1, y: 697, width: w('{{signature:A}}') + 2, height: 13, text: '{{signature:A}}' }]);
    expect(out.not_removed).toEqual([]);
    const text = joined(await extractTextLayer(out.bytes)).replace(/\s+/g, '');
    expect(text).toBe('OddfontlineSignhere');
  });

  it('a tag drawn inside a form XObject cannot be removed: it is reported, covered, and the page text is unchanged', async () => {
    const doc = await PDFDocument.create();
    const page: PDFPage = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const embedded = await doc.embedPage(await (async () => {
      const src = await PDFDocument.create();
      const p = src.addPage([300, 50]);
      p.drawText('Inner {{signature:Seller}}', { x: 0, y: 20, size: 11, font: await src.embedFont(StandardFonts.Helvetica) });
      return (await PDFDocument.load(await src.save())).getPage(0);
    })());
    page.drawPage(embedded, { x: 72, y: 680 });
    page.drawText('Outside text', { x: 72, y: 600, size: 11, font });
    const bytes = await doc.save({ useObjectStreams: false });
    const before = await extractTextLayer(bytes);
    const box: PdfTextTagBox = { page_number: 0, x: 72 + font.widthOfTextAtSize('Inner ', 11) - 1, y: 695, width: font.widthOfTextAtSize('{{signature:Seller}}', 11) + 2, height: 16, text: '{{signature:Seller}}' };
    const out = await removeAndCoverTextTags(bytes, [box]);
    expect(out.not_removed).toEqual([0]);
    const after = await extractTextLayer(out.bytes);
    expect(joined(after)).toBe(joined(before));
    expect(otherWords(after)).toEqual(otherWords(before));
  });

  it('a tag whose text is not where its box says is reported, and the page text stays as it was', async () => {
    const { bytes, tags } = await standardFontPdf();
    const [first, second] = tags as [PdfTextTagBox, PdfTextTagBox];
    const out = await removeAndCoverTextTags(bytes, [{ ...first, y: 100 }, second]);
    expect(out.not_removed).toEqual([0]);
    const after = await extractTextLayer(out.bytes);
    expect(joined(after)).toContain('{{signature:seller}}');
    expect(joined(after)).not.toContain('text:Buyer');
  });
});
