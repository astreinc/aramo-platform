import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFString, StandardFonts, decodePDFRawStream, type PDFPage } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { PdfFormImportError, SafePdfPipeline, UnsafePdfError, coverPdfBoxes, extractTextLayer, importPdfForm, readPageFrames } from '../index.js';

// FIELD-PARITY-1 P2-5 / P2-6 — the PDF half of fillable-PDF import and text-tag covering.
// Every fixture is generated here with pdf-lib: a form with text, multi-line text, check box,
// radio group, dropdown, list box, push button and signature fields; one carrying field /AA
// JavaScript, a document JavaScript name tree and a JavaScript /OpenAction (must be
// stripped); a hybrid XFA form (XFA stripped); an XFA-only form (refused).

const N = PDFName.of;

function addSignatureField(doc: PDFDocument, page: PDFPage, name: string, rect: [number, number, number, number], signed = false): void {
  const ctx = doc.context;
  const field = ctx.obj({ FT: 'Sig', T: PDFString.of(name), Type: 'Annot', Subtype: 'Widget', Rect: rect, F: 4, P: page.ref });
  if (signed) field.set(N('V'), ctx.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite' }));
  const ref = ctx.register(field);
  const acro = doc.catalog.lookup(N('AcroForm'), PDFDict);
  acro.lookup(N('Fields'), PDFArray).push(ref);
  const annots = page.node.Annots() ?? ctx.obj([]);
  annots.push(ref);
  page.node.set(N('Annots'), annots);
}

const jsAction = (doc: PDFDocument): PDFRef => doc.context.register(doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("hi")') }));

async function formPdf(opts: { activeContent?: boolean; xfa?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawText('Application form', { x: 50, y: 740, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  const form = doc.getForm();
  const name = form.createTextField('applicant.name');
  name.enableRequired();
  name.addToPage(page, { x: 50, y: 680, width: 220, height: 20 });
  const notes = form.createTextField('notes');
  notes.enableMultiline();
  notes.addToPage(page, { x: 50, y: 580, width: 300, height: 80 });
  const agree = form.createCheckBox('agree');
  agree.addToPage(page, { x: 50, y: 540, width: 12, height: 12 });
  agree.acroField.dict.set(N('TU'), PDFString.of('I agree to the terms'));
  const colour = form.createRadioGroup('colour');
  colour.addOptionToPage('Red', page, { x: 50, y: 500, width: 12, height: 12 });
  colour.addOptionToPage('Blue', page, { x: 90, y: 500, width: 12, height: 12 });
  const state = form.createDropdown('state');
  state.setOptions(['NY', 'CA']);
  state.addToPage(page, { x: 50, y: 460, width: 100, height: 20 });
  const list = form.createOptionList('fruits');
  list.setOptions(['Apple', 'Pear']);
  list.addToPage(page, { x: 200, y: 440, width: 100, height: 40 });
  const total = form.createTextField('total');
  total.enableReadOnly();
  total.addToPage(page, { x: 300, y: 680, width: 100, height: 20 });
  form.createButton('print').addToPage('Print', page, { x: 400, y: 50, width: 60, height: 20 });
  addSignatureField(doc, page, 'signer1', [50, 100, 280, 150]);
  addSignatureField(doc, page, 'already', [300, 100, 530, 150], true);
  const ctx = doc.context;
  if (opts.activeContent === true) {
    name.acroField.dict.set(N('AA'), ctx.obj({ K: jsAction(doc) }));
    for (const w of name.acroField.getWidgets()) w.dict.set(N('AA'), ctx.obj({ Fo: jsAction(doc) }));
    agree.acroField.dict.set(N('A'), ctx.obj({ S: 'SubmitForm', F: PDFString.of('https://example.invalid/collect') }));
    doc.catalog.set(N('OpenAction'), jsAction(doc));
    doc.catalog.set(N('AA'), ctx.obj({ WC: jsAction(doc) }));
    doc.catalog.set(N('Names'), ctx.obj({ JavaScript: ctx.obj({ Names: [PDFString.of('init'), jsAction(doc)] }) }));
    page.node.set(N('AA'), ctx.obj({ O: jsAction(doc) }));
  }
  if (opts.xfa === true) {
    const xfa = ctx.register(ctx.stream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"></xdp:xdp>'));
    doc.catalog.lookup(N('AcroForm'), PDFDict).set(N('XFA'), xfa);
  }
  // updateFieldAppearances off: pdf-lib's save would otherwise open the form and drop /XFA.
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

async function xfaOnlyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const ctx = doc.context;
  const xfa = ctx.register(ctx.stream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"></xdp:xdp>'));
  doc.catalog.set(N('AcroForm'), ctx.obj({ Fields: [], XFA: xfa }));
  return doc.save({ useObjectStreams: false });
}

async function plainPdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawText(text, { x: 72, y: 700, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
  return doc.save({ useObjectStreams: false });
}

async function pageOperators(bytes: Uint8Array, index = 0): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(index).node.Contents();
  const refs: PDFRef[] = [];
  if (contents instanceof PDFArray) for (let i = 0; i < contents.size(); i += 1) refs.push(contents.get(i) as PDFRef);
  let out = '';
  for (const ref of refs) {
    const stream = doc.context.lookup(ref);
    if (stream instanceof PDFRawStream) out += `${Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')}\n`;
  }
  return out;
}

const latin1 = (b: Uint8Array): string => Buffer.from(b).toString('latin1');

describe('P2-5 importPdfForm — read', () => {
  it('reads every field kind with its name, tooltip, flags, option, page and box', async () => {
    const out = await importPdfForm(await formPdf());
    const byName = (n: string) => out.widgets.filter((w) => w.name === n);
    expect(out.changed).toBe(true);
    expect(out.pages).toEqual([{ width: 612, height: 792 }]);
    expect(out.widgets.map((w) => [w.name, w.kind])).toEqual([
      ['applicant.name', 'text'],
      ['notes', 'multiline_text'],
      ['agree', 'checkbox'],
      ['colour', 'radio'],
      ['colour', 'radio'],
      ['state', 'dropdown'],
      ['fruits', 'list'],
      ['total', 'text'],
      ['print', 'push_button'],
      ['signer1', 'signature'],
      ['already', 'signature'],
    ]);
    // pdf-lib grows a widget's Rect by half its 1pt border.
    expect(byName('applicant.name')[0]).toMatchObject({ required: true, read_only: false, page_number: 0, x: 49.5, y: 679.5, width: 221, height: 21 });
    expect(byName('agree')[0]).toMatchObject({ tooltip: 'I agree to the terms', width: 13, height: 13 });
    expect(byName('colour').map((w) => w.option)).toEqual(['Red', 'Blue']);
    expect(byName('total')[0]?.read_only).toBe(true);
    expect(byName('signer1')[0]).toMatchObject({ signed: false, x: 50, y: 100, width: 230, height: 50 });
    expect(byName('already')[0]?.signed).toBe(true);
  });

  it('FIELD-PARITY-2 A-5 reads a choice field\'s /Opt (export value and display text); other kinds carry none', async () => {
    const out = await importPdfForm(await formPdf());
    const byName = (n: string) => out.widgets.filter((w) => w.name === n);
    expect(byName('state')[0]?.choices).toEqual([
      { value: 'NY', label: 'NY' },
      { value: 'CA', label: 'CA' },
    ]);
    expect(byName('fruits')[0]?.choices).toEqual([
      { value: 'Apple', label: 'Apple' },
      { value: 'Pear', label: 'Pear' },
    ]);
    expect(byName('applicant.name')[0]?.choices).toBeNull();
    expect(byName('colour')[0]?.choices).toBeNull();
  });

  it('FIELD-PARITY-2 A-5 reads [export, display] pairs, an empty /Opt as [] and a malformed entry as an empty choice', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const pairs = form.createDropdown('country');
    pairs.addToPage(page, { x: 50, y: 600, width: 100, height: 20 });
    const ctx = doc.context;
    pairs.acroField.dict.set(N('Opt'), ctx.obj([ctx.obj([PDFString.of('us'), PDFString.of('United States')]), PDFString.of('Other')]));
    const none = form.createDropdown('empty');
    none.addToPage(page, { x: 50, y: 560, width: 100, height: 20 });
    none.acroField.dict.delete(N('Opt'));
    const bad = form.createDropdown('broken');
    bad.addToPage(page, { x: 50, y: 520, width: 100, height: 20 });
    bad.acroField.dict.set(N('Opt'), ctx.obj([PDFString.of('ok'), 7]));
    const out = await importPdfForm(await doc.save({ useObjectStreams: false, updateFieldAppearances: false }));
    const byName = (n: string) => out.widgets.find((w) => w.name === n);
    expect(byName('country')?.choices).toEqual([
      { value: 'us', label: 'United States' },
      { value: 'Other', label: 'Other' },
    ]);
    expect(byName('empty')?.choices).toEqual([]);
    expect(byName('broken')?.choices).toEqual([
      { value: 'ok', label: 'ok' },
      { value: '', label: '' },
    ]);
  });

  it('returns a PDF without a form unchanged (same bytes)', async () => {
    const bytes = await plainPdf('No form here');
    const out = await importPdfForm(bytes);
    expect(out.changed).toBe(false);
    expect(out.bytes).toBe(bytes);
    expect(out.widgets).toEqual([]);
  });

  it('returns an unreadable file unchanged (the safe-upload gate decides)', async () => {
    const bytes = new Uint8Array(Buffer.from('%PDF-1.7 not really'));
    const out = await importPdfForm(bytes);
    expect(out).toMatchObject({ changed: false, widgets: [] });
    expect(out.bytes).toBe(bytes);
  });
});

describe('P2-5 importPdfForm — strip and flatten', () => {
  it('the original with field / document JavaScript is refused by the gate; the import passes it', async () => {
    const bytes = await formPdf({ activeContent: true });
    await expect(new SafePdfPipeline().accept(bytes)).rejects.toBeInstanceOf(UnsafePdfError);
    const out = await importPdfForm(bytes);
    expect([...out.stripped].sort()).toEqual(['/A', '/AA', '/AcroForm', '/JavaScript', '/OpenAction']);
    await expect(new SafePdfPipeline().accept(out.bytes)).resolves.toBe(out.bytes);
    const raw = latin1(out.bytes);
    for (const token of ['/AcroForm', '/Widget', '/JavaScript', '/JS', '/AA', '/OpenAction', '/SubmitForm', '/XFA']) {
      expect(raw.includes(`${token} `) || raw.includes(`${token}\n`) || raw.includes(`${token}/`) || raw.includes(`${token}(`) || raw.includes(`${token}<`)).toBe(false);
    }
  });

  it('leaves no form fields and no widget annotations (flattened)', async () => {
    const out = await importPdfForm(await formPdf({ activeContent: true }));
    const doc = await PDFDocument.load(out.bytes);
    expect(doc.catalog.get(N('AcroForm'))).toBeUndefined();
    const annots = doc.getPage(0).node.Annots();
    expect(annots === undefined || annots.size() === 0).toBe(true);
    // pdf-lib sees no form at all (getForm would create an empty one; it has no fields).
    expect(doc.getForm().getFields()).toHaveLength(0);
  });

  it('draws each visible widget appearance into the page content', async () => {
    const out = await importPdfForm(await formPdf());
    const ops = await pageOperators(out.bytes);
    const draws = ops.match(/\/FlatWidget-\d+ Do/g) ?? [];
    // 11 widgets (the radio group has 2); the 2 hand-made signature widgets have no appearance.
    expect(draws).toHaveLength(9);
    // The text field: its appearance mapped onto its Rect at (49.5, 679.5).
    expect(ops).toMatch(/1 0 0 1 49\.5 679\.5 cm\n\/FlatWidget-\d+ Do/);
    // The original page content is wrapped in q … Q before the appended drawing.
    expect(ops.trimStart().startsWith('q')).toBe(true);
  });

  it('strips a hybrid XFA form\'s XFA and keeps its AcroForm fields', async () => {
    const out = await importPdfForm(await formPdf({ xfa: true }));
    expect(out.stripped).toContain('/XFA');
    expect(out.widgets.length).toBeGreaterThan(0);
    expect(latin1(out.bytes).includes('/XFA')).toBe(false);
    expect(latin1(out.bytes).includes('xdp:xdp')).toBe(false);
  });

  it('refuses an XFA-only form with a named reason', async () => {
    await expect(importPdfForm(await xfaOnlyPdf())).rejects.toMatchObject({ name: 'PdfFormImportError', reason: 'xfa_only_form' });
    await expect(importPdfForm(await xfaOnlyPdf())).rejects.toBeInstanceOf(PdfFormImportError);
  });
});

describe('P2-6 coverPdfBoxes and the shared text layer', () => {
  it('returns the bytes unchanged with no box', async () => {
    const bytes = await plainPdf('x');
    expect(await coverPdfBoxes(bytes, [])).toBe(bytes);
  });

  it('paints a white rectangle over the box, after the (wrapped) page content', async () => {
    const bytes = await plainPdf('Sign here {{signature:Seller}}');
    const out = await coverPdfBoxes(bytes, [{ page_number: 0, x: 120, y: 697, width: 130, height: 14 }]);
    const ops = await pageOperators(out);
    // pdf-lib draws the rectangle as a filled path: white fill, moved to (120, 697), 130 x 14.
    const cover = /q\n1 1 1 rg\n0 w\n\[\] 0 d\n1 0 0 1 120 697 cm\n(?:1 0 0 1 0 0 cm\n)*0 0 m\n0 14 l\n130 14 l\n130 0 l\nh\nf\nQ/;
    expect(ops).toMatch(cover);
    expect(ops.search(cover)).toBeGreaterThan(ops.lastIndexOf('Tj'));
    await expect(new SafePdfPipeline().accept(out)).resolves.toBe(out);
  });

  it('extracts words and page frames (moved from sign-service; same output)', async () => {
    const bytes = await plainPdf('Sign here {{signature:Seller}}');
    const pages = await extractTextLayer(bytes);
    expect(pages[0]?.words.map((w) => w.t)).toEqual(['Sign', 'here', '{{signature:Seller}}']);
    expect(await readPageFrames(bytes)).toEqual([{ width: 612, height: 792, view: { x: 0, y: 0, width: 612, height: 792 }, rotation: 0 }]);
  });
});
