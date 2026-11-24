import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFContext,
  type PDFObject,
  type PDFPage,
} from 'pdf-lib';

// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §5 —
// the PDF half of P2-5 (fillable-PDF import) and P2-6 (covering text tags, ruling R-5). The
// catalog half (which form field becomes which catalog field; the tag syntax) is
// @aramo/sign-fields field-import.ts. pdf-lib use in this lib is confined to the rendering
// adapter, the safe-upload pipeline, THIS file (deliberately extended for P2-5 / P2-6) and
// pdf-tag-text.ts (FIELD-PARITY-2 A-6: removing a tag's text, ruling C-8).
//
// importPdfForm — opt-in only (the hosts' `import_fields` flag). Nothing in the PDF is ever
// executed: the file is parsed as data, never rendered or scripted.
//   1. Read every terminal form field and its widgets (name, tooltip, kind, flags, box, page;
//      a choice field's /Opt list, FIELD-PARITY-2 A-5).
//   2. Strip the form's active content: the whole /AcroForm (with /XFA, /CO calculation
//      order, and every field's /A and /AA actions), the catalog's /AA, a JavaScript
//      /OpenAction, the document JavaScript name tree (/Names /JavaScript) and each page's /AA.
//      Anything else (a link's Launch action, embedded files, rich media, a non-JavaScript
//      /OpenAction) is left in place for the existing safe-upload gates to refuse, as today.
//   3. Flatten: each visible widget's normal appearance is drawn into the page content as a
//      form XObject (ISO 32000-1 §12.5.5 mapping of the appearance's BBox / Matrix onto the
//      widget Rect); every widget annotation is removed.
//   4. Drop every object no longer reachable from the trailer, so stripped actions are not
//      written out (pdf-lib otherwise writes every parsed object), then save a fresh file
//      (no incremental update: earlier revisions are gone).
// A form that is XFA only (an /XFA stream and no AcroForm widgets) cannot be flattened into
// anything meaningful: it is refused (PdfFormImportError 'xfa_only_form'). A file pdf-lib
// cannot load, or one without a form, is returned unchanged (`changed: false`) so the
// existing gates decide exactly as they do without the flag.

export type PdfFormKind = 'text' | 'multiline_text' | 'checkbox' | 'radio' | 'dropdown' | 'list' | 'signature' | 'push_button';

/** One widget of a terminal form field (structurally @aramo/sign-fields PdfFormWidget). */
export interface PdfFormWidgetRead {
  kind: PdfFormKind;
  name: string;
  tooltip: string | null;
  required: boolean;
  read_only: boolean;
  hidden: boolean;
  signed: boolean;
  option: string | null;
  /**
   * FIELD-PARITY-2 A-5 — a choice field's (dropdown / list box) /Opt entries in order: the
   * export value and the display text (ISO 32000-1 §12.7.4.4; a plain string is both). An entry
   * that is neither a string nor a pair of strings is read as an empty choice, so the planner
   * sees the list does not fit. [] for a choice field without /Opt; null for any other kind.
   */
  choices: Array<{ value: string; label: string }> | null;
  page_number: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfFormImport {
  /** The flattened, stripped PDF (the input bytes when `changed` is false). */
  bytes: Uint8Array;
  changed: boolean;
  widgets: PdfFormWidgetRead[];
  /** Each page's media box size (points). */
  pages: Array<{ width: number; height: number }>;
  /** What was removed, by PDF key: "/AcroForm", "/XFA", "/A" and "/AA" (field, widget, page or document actions), "/JavaScript", "/OpenAction". */
  stripped: string[];
}

export class PdfFormImportError extends Error {
  constructor(
    public readonly reason: 'xfa_only_form',
    message: string,
  ) {
    super(message);
    this.name = 'PdfFormImportError';
  }
}

const N = (s: string): PDFName => PDFName.of(s);
const MAX_DEPTH = 32;
// Field flags (ISO 32000-1 Table 221, 226, 228, 230).
const FF_READ_ONLY = 1;
const FF_REQUIRED = 2;
const FF_MULTILINE = 1 << 12;
const FF_RADIO = 1 << 15;
const FF_PUSH_BUTTON = 1 << 16;
const FF_COMBO = 1 << 17;
// Annotation flags (Table 165): Hidden, NoView.
const F_HIDDEN = 2;
const F_NO_VIEW = 32;

function dictOf(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  return v instanceof PDFDict ? v : undefined;
}

function arrayOf(ctx: PDFContext, o: PDFObject | undefined): PDFArray | undefined {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  return v instanceof PDFArray ? v : undefined;
}

function textOf(ctx: PDFContext, o: PDFObject | undefined): string | null {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  return null;
}

function numOf(ctx: PDFContext, o: PDFObject | undefined): number | null {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  return v instanceof PDFNumber ? v.asNumber() : null;
}

/** An inheritable field attribute (/FT, /Ff, /V), looked up through /Parent. */
function inherited(ctx: PDFContext, dict: PDFDict, key: string): PDFObject | undefined {
  let d: PDFDict | undefined = dict;
  for (let i = 0; d !== undefined && i < MAX_DEPTH; i += 1) {
    const v = d.get(N(key));
    if (v !== undefined) return v instanceof PDFRef ? ctx.lookup(v) : v;
    d = dictOf(ctx, d.get(N('Parent')));
  }
  return undefined;
}

function nums(ctx: PDFContext, o: PDFObject | undefined, n: number): number[] | null {
  const a = arrayOf(ctx, o);
  if (a === undefined || a.size() < n) return null;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const v = numOf(ctx, a.get(i));
    if (v === null || !Number.isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

function kindOf(ctx: PDFContext, field: PDFDict): PdfFormKind | null {
  const ft = inherited(ctx, field, 'FT');
  const ff = numOf(ctx, inherited(ctx, field, 'Ff')) ?? 0;
  if (!(ft instanceof PDFName)) return null;
  switch (ft.asString()) {
    case '/Tx':
      return (ff & FF_MULTILINE) !== 0 ? 'multiline_text' : 'text';
    case '/Btn':
      if ((ff & FF_PUSH_BUTTON) !== 0) return 'push_button';
      return (ff & FF_RADIO) !== 0 ? 'radio' : 'checkbox';
    case '/Ch':
      return (ff & FF_COMBO) !== 0 ? 'dropdown' : 'list';
    case '/Sig':
      return 'signature';
    default:
      return null;
  }
}

interface Terminal {
  field: PDFDict;
  name: string;
  widgets: PDFDict[];
}

/** Every terminal field under /AcroForm /Fields (a field whose kids are widgets, or none). */
function terminalsOf(ctx: PDFContext, acro: PDFDict): Terminal[] {
  const out: Terminal[] = [];
  const seen = new Set<PDFDict>();
  const walk = (o: PDFObject | undefined, parent: string, depth: number): void => {
    const d = dictOf(ctx, o);
    if (d === undefined || depth > MAX_DEPTH || seen.has(d)) return;
    seen.add(d);
    const t = textOf(ctx, d.get(N('T')));
    const name = t === null ? parent : parent.length > 0 ? `${parent}.${t}` : t;
    const kids = arrayOf(ctx, d.get(N('Kids')));
    const kidDicts: PDFDict[] = [];
    if (kids !== undefined) for (let i = 0; i < kids.size(); i += 1) {
      const k = dictOf(ctx, kids.get(i));
      if (k !== undefined) kidDicts.push(k);
    }
    const fieldKids = kidDicts.filter((k) => k.get(N('T')) !== undefined);
    if (fieldKids.length > 0) {
      for (let i = 0; i < (kids?.size() ?? 0); i += 1) walk(kids?.get(i), name, depth + 1);
      return;
    }
    out.push({ field: d, name: name.length > 0 ? name : 'Field', widgets: kidDicts.length > 0 ? kidDicts : [d] });
  };
  const fields = arrayOf(ctx, acro.get(N('Fields')));
  for (let i = 0; i < (fields?.size() ?? 0); i += 1) walk(fields?.get(i), '', 0);
  return out;
}

/** The on-state name of a check box / radio widget (its /AP /N keys other than /Off). */
function onValueOf(ctx: PDFContext, widget: PDFDict): string | null {
  const ap = dictOf(ctx, widget.get(N('AP')));
  const n = dictOf(ctx, ap?.get(N('N')));
  if (n === undefined) return null;
  for (const [k] of n.entries()) {
    const s = k.decodeText();
    if (s !== 'Off') return s;
  }
  return null;
}

/**
 * A button's export value: its on-state name, or — when the field has an /Opt array and the
 * on-state is an index into it (ISO 32000-1 §12.7.4.2.4; pdf-lib writes radios this way) —
 * the text at that index.
 */
function exportValueOf(ctx: PDFContext, field: PDFDict, on: string | null): string | null {
  if (on === null || !/^\d+$/.test(on)) return on;
  const opt = arrayOf(ctx, inherited(ctx, field, 'Opt'));
  const text = opt === undefined ? null : textOf(ctx, opt.get(Number(on)));
  return text ?? on;
}

/** FIELD-PARITY-2 A-5 — a choice field's /Opt entries (see PdfFormWidgetRead.choices). */
function choicesOf(ctx: PDFContext, field: PDFDict): Array<{ value: string; label: string }> {
  const opt = arrayOf(ctx, inherited(ctx, field, 'Opt'));
  if (opt === undefined) return [];
  const out: Array<{ value: string; label: string }> = [];
  for (let i = 0; i < opt.size(); i += 1) {
    const raw = opt.get(i);
    const text = textOf(ctx, raw);
    if (text !== null) {
      out.push({ value: text, label: text });
      continue;
    }
    const pair = arrayOf(ctx, raw);
    const value = pair === undefined ? null : textOf(ctx, pair.get(0));
    const label = pair === undefined ? null : textOf(ctx, pair.get(1));
    out.push(value !== null && label !== null ? { value, label } : { value: '', label: '' });
  }
  return out;
}

/** The widget's normal appearance stream ref (the current /AS state of a state dictionary). */
function appearanceRefOf(ctx: PDFContext, widget: PDFDict): PDFRef | null {
  const ap = dictOf(ctx, widget.get(N('AP')));
  const raw = ap?.get(N('N'));
  if (raw === undefined) return null;
  const nObj = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
  let pick: PDFObject | undefined = raw;
  if (!(nObj instanceof PDFStream)) {
    if (!(nObj instanceof PDFDict)) return null;
    const as = widget.get(N('AS'));
    pick = as instanceof PDFName ? nObj.get(as) : undefined;
    if (pick === undefined) pick = nObj.get(N('Off'));
  }
  if (pick === undefined) return null;
  const stream = pick instanceof PDFRef ? ctx.lookup(pick) : pick;
  if (!(stream instanceof PDFStream)) return null;
  return pick instanceof PDFRef ? pick : ctx.register(stream);
}

/** ISO 32000-1 §12.5.5 — the matrix that maps the appearance's (transformed) BBox onto Rect. */
function flattenMatrix(ctx: PDFContext, appearance: PDFStream, rect: number[]): [number, number, number, number, number, number] | null {
  const bbox = nums(ctx, appearance.dict.get(N('BBox')), 4);
  if (bbox === null) return null;
  const [a, b, c, d, e, f] = nums(ctx, appearance.dict.get(N('Matrix')), 6) ?? [1, 0, 0, 1, 0, 0];
  const [bx0 = 0, by0 = 0, bx1 = 0, by1 = 0] = bbox;
  const pts = [
    [bx0, by0],
    [bx1, by0],
    [bx0, by1],
    [bx1, by1],
  ].map(([x = 0, y = 0]) => [(a ?? 1) * x + (c ?? 0) * y + (e ?? 0), (b ?? 0) * x + (d ?? 1) * y + (f ?? 0)]);
  const xs = pts.map((p) => p[0] ?? 0);
  const ys = pts.map((p) => p[1] ?? 0);
  const tx0 = Math.min(...xs);
  const ty0 = Math.min(...ys);
  const tw = Math.max(...xs) - tx0;
  const th = Math.max(...ys) - ty0;
  const [rx0 = 0, ry0 = 0, rx1 = 0, ry1 = 0] = rect;
  const rw = Math.abs(rx1 - rx0);
  const rh = Math.abs(ry1 - ry0);
  if (tw <= 0 || th <= 0 || rw <= 0 || rh <= 0) return null;
  const sx = rw / tw;
  const sy = rh / th;
  return [sx, 0, 0, sy, Math.min(rx0, rx1) - tx0 * sx, Math.min(ry0, ry1) - ty0 * sy];
}

function isJavaScriptAction(ctx: PDFContext, o: PDFObject | undefined): boolean {
  const d = dictOf(ctx, o);
  const s = d?.get(N('S'));
  return s instanceof PDFName && s.asString() === '/JavaScript';
}

/** Deletes every indirect object not reachable from the trailer (Root, Info). */
export function dropUnreachable(ctx: PDFContext): void {
  const reachable = new Set<string>();
  const stack: PDFObject[] = [];
  if (ctx.trailerInfo.Root !== undefined) stack.push(ctx.trailerInfo.Root);
  if (ctx.trailerInfo.Info !== undefined) stack.push(ctx.trailerInfo.Info);
  while (stack.length > 0) {
    const o = stack.pop();
    if (o instanceof PDFRef) {
      if (reachable.has(o.tag)) continue;
      reachable.add(o.tag);
      const v = ctx.lookup(o);
      if (v !== undefined) stack.push(v);
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) stack.push(v);
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref.tag)) ctx.delete(ref);
  }
}

/** Puts the page's existing content inside q … Q once, so appended drawing starts from a clean state. */
function isolateContent(doc: PDFDocument, page: PDFPage, done: Set<PDFPage>): void {
  if (done.has(page)) return;
  done.add(page);
  page.node.wrapContentStreams(doc.context.getPushGraphicsStateContentStream(), doc.context.getPopGraphicsStateContentStream());
}

/** P2-5 — read the form's fields, strip its active content and flatten it (see the header). */
export async function importPdfForm(bytes: Uint8Array): Promise<PdfFormImport> {
  let doc: PDFDocument;
  try {
    // Never ignoreEncryption: an encrypted file is left to the safe-upload gate's refusal.
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    return { bytes, changed: false, widgets: [], pages: [], stripped: [] };
  }
  const ctx = doc.context;
  const catalog = doc.catalog;
  let pages: PDFPage[];
  try {
    pages = doc.getPages();
  } catch {
    // No usable page tree: left to the safe-upload gate's structural check.
    return { bytes, changed: false, widgets: [], pages: [], stripped: [] };
  }
  const pageSizes = pages.map((p) => ({ width: p.getWidth(), height: p.getHeight() }));
  const acro = dictOf(ctx, catalog.get(N('AcroForm')));
  if (acro === undefined) return { bytes, changed: false, widgets: [], pages: pageSizes, stripped: [] };
  const hasXfa = acro.get(N('XFA')) !== undefined;
  const terminals = terminalsOf(ctx, acro);

  // Which page holds each widget annotation.
  const pageOfAnnot = new Map<PDFDict, number>();
  pages.forEach((p, i) => {
    const annots = arrayOf(ctx, p.node.get(N('Annots')));
    for (let k = 0; k < (annots?.size() ?? 0); k += 1) {
      const a = dictOf(ctx, annots?.get(k));
      if (a !== undefined && !pageOfAnnot.has(a)) pageOfAnnot.set(a, i);
    }
  });
  const pageRefIndex = new Map<string, number>(pages.map((p, i) => [p.ref.tag, i]));

  const widgets: PdfFormWidgetRead[] = [];
  const fieldActions = new Set<string>();
  // Every field, ancestor field and widget dictionary: their actions are deleted below.
  const actionHolders = new Set<PDFDict>();
  for (const t of terminals) {
    for (const w of t.widgets) actionHolders.add(w);
    for (let d: PDFDict | undefined = t.field, i = 0; d !== undefined && i < MAX_DEPTH; d = dictOf(ctx, d.get(N('Parent'))), i += 1) {
      actionHolders.add(d);
      if (d.get(N('AA')) !== undefined) fieldActions.add('/AA');
      if (d.get(N('A')) !== undefined) fieldActions.add('/A');
    }
    const kind = kindOf(ctx, t.field);
    if (kind === null) continue;
    const ff = numOf(ctx, inherited(ctx, t.field, 'Ff')) ?? 0;
    const tooltip = textOf(ctx, t.field.get(N('TU')));
    const signed = kind === 'signature' && inherited(ctx, t.field, 'V') !== undefined;
    const choices = kind === 'dropdown' || kind === 'list' ? choicesOf(ctx, t.field) : null;
    for (const w of t.widgets) {
      const rect = nums(ctx, w.get(N('Rect')), 4);
      const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = rect ?? [];
      const p = w.get(N('P'));
      const page_number = pageOfAnnot.get(w) ?? (p instanceof PDFRef ? pageRefIndex.get(p.tag) : undefined) ?? null;
      const f = numOf(ctx, w.get(N('F'))) ?? 0;
      widgets.push({
        kind,
        name: t.name,
        tooltip: tooltip !== null && tooltip.trim().length > 0 ? tooltip.trim() : null,
        required: (ff & FF_REQUIRED) !== 0,
        read_only: (ff & FF_READ_ONLY) !== 0,
        hidden: (f & (F_HIDDEN | F_NO_VIEW)) !== 0,
        signed,
        option: kind === 'radio' || kind === 'checkbox' ? exportValueOf(ctx, t.field, onValueOf(ctx, w)) : null,
        choices: choices === null ? null : choices.map((c) => ({ ...c })),
        page_number: rect === null ? null : page_number,
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        width: Math.abs(x1 - x0),
        height: Math.abs(y1 - y0),
      });
    }
  }
  if (hasXfa && widgets.length === 0) {
    throw new PdfFormImportError('xfa_only_form', 'This is an XFA-only form, which cannot be imported. Save it as a standard (AcroForm) PDF and upload it again.');
  }

  const stripped = new Set<string>(['/AcroForm', ...fieldActions]);
  if (hasXfa) stripped.add('/XFA');
  // Flatten every widget annotation (with or without a field) and drop it from the page.
  const isolated = new Set<PDFPage>();
  pages.forEach((page) => {
    if (page.node.get(N('AA')) !== undefined) {
      page.node.delete(N('AA'));
      stripped.add('/AA');
    }
    const annots = arrayOf(ctx, page.node.get(N('Annots')));
    if (annots === undefined) return;
    const keep: PDFObject[] = [];
    for (let k = 0; k < annots.size(); k += 1) {
      const raw = annots.get(k);
      const a = dictOf(ctx, raw);
      const subtype = a?.get(N('Subtype'));
      if (a === undefined || !(subtype instanceof PDFName) || subtype.asString() !== '/Widget') {
        keep.push(raw);
        continue;
      }
      actionHolders.add(a);
      if (a.get(N('AA')) !== undefined) stripped.add('/AA');
      if (a.get(N('A')) !== undefined) stripped.add('/A');
      const f = numOf(ctx, a.get(N('F'))) ?? 0;
      const rect = nums(ctx, a.get(N('Rect')), 4);
      const apRef = (f & (F_HIDDEN | F_NO_VIEW)) === 0 && rect !== null ? appearanceRefOf(ctx, a) : null;
      const ap = apRef === null ? undefined : ctx.lookup(apRef);
      const m = ap instanceof PDFStream && rect !== null ? flattenMatrix(ctx, ap, rect) : null;
      if (apRef !== null && m !== null) {
        isolateContent(doc, page, isolated);
        const key = page.node.newXObject('FlatWidget', apRef);
        page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m), drawObject(key), popGraphicsState());
      }
    }
    if (keep.length === 0) page.node.delete(N('Annots'));
    else page.node.set(N('Annots'), ctx.obj(keep));
  });

  // Removing the form and the widget annotations is not enough on a tagged PDF: its structure
  // tree (/StructTreeRoot … /OBJR /Obj) still points at every field and widget, so they stay
  // reachable and are written out, scripts included (the USCIS I-9 is one). Delete the
  // actions themselves.
  for (const d of actionHolders) {
    d.delete(N('A'));
    d.delete(N('AA'));
  }

  // The form and every script that belongs to it.
  catalog.delete(N('AcroForm'));
  if (catalog.get(N('AA')) !== undefined) {
    catalog.delete(N('AA'));
    stripped.add('/AA');
  }
  if (isJavaScriptAction(ctx, catalog.get(N('OpenAction')))) {
    catalog.delete(N('OpenAction'));
    stripped.add('/OpenAction');
  }
  const names = dictOf(ctx, catalog.get(N('Names')));
  if (names?.get(N('JavaScript')) !== undefined) {
    names.delete(N('JavaScript'));
    stripped.add('/JavaScript');
  }
  dropUnreachable(ctx);
  const out = await doc.save({ useObjectStreams: false });
  return { bytes: out, changed: true, widgets, pages: pageSizes, stripped: [...stripped] };
}

/** One rectangle to paint white (field frame: 0-based page, points, bottom-left origin). */
export interface PdfCoverBox {
  page_number: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * P2-6 / ruling R-5 — paints each box white (no border) on top of the page content, so a text
 * tag is not visible on the stored PDF. With no box the bytes are returned unchanged.
 */
export async function coverPdfBoxes(bytes: Uint8Array, boxes: readonly PdfCoverBox[]): Promise<Uint8Array> {
  const usable = boxes.filter((b) => b.width > 0 && b.height > 0);
  if (usable.length === 0) return bytes;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  coverPagesWithBoxes(doc, usable);
  return doc.save({ useObjectStreams: false });
}

/** Paints each box white on top of its page (the drawing half of coverPdfBoxes, on a loaded document). */
export function coverPagesWithBoxes(doc: PDFDocument, boxes: readonly PdfCoverBox[]): void {
  const pages = doc.getPages();
  const isolated = new Set<PDFPage>();
  for (const b of boxes) {
    if (!(b.width > 0 && b.height > 0)) continue;
    const page = pages[b.page_number];
    if (page === undefined) continue;
    isolateContent(doc, page, isolated);
    page.drawRectangle({ x: b.x, y: b.y, width: b.width, height: b.height, color: rgb(1, 1, 1), borderWidth: 0 });
  }
}
