// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §5 —
// P2-5 fillable-PDF (AcroForm) import and P2-6 text tags (ruling R-5): the ONE set of rules
// that turns what a PDF carries into catalog fields. Both hosts (the console fixed-form upload
// in apps/api and the Sign envelope document upload in apps/sign-service) call these; the
// PDF work itself (reading the form, flattening, the text layer, covering a tag) is in
// @aramo/documents-rendering. Role / recipient binding stays with the host (fixed-form roles
// vs envelope recipients).
//
// Geometry: the field frame every host stores — page_number 0-based, PDF points, origin at the
// page's BOTTOM-LEFT, (x, y) the box's lower-left corner.
//
// Pure TypeScript ESM, no dependency (scope:shared).

import { FIELD_DEFAULTS, isFieldTypeKey, isFieldTypeOn, fieldSettingsOf, type FieldSurface, type FieldTypeKey } from './catalog.js';
import { FIELD_GROUP_KEY_MAX, FIELD_LABEL_MAX, parseTemplateFieldSettings, type FieldOptions } from './field-settings.js';

// ── Shared ─────────────────────────────────────────────────────────────────────

/** The smallest box an imported field gets (the fixed-form minimum, 8 points each way). */
export const IMPORT_MIN_FIELD_SIZE = 8;
/** The white margin drawn around a text tag when it is covered (points). */
export const TEXT_TAG_COVER_PAD = 1;

/** A field found in the PDF, ready for the host to bind to a role / recipient. */
export interface ImportedField {
  readonly source: 'pdf_form' | 'text_tag';
  /** The PDF form field's name, or the tag text (without the braces). */
  readonly name: string;
  readonly field_type: FieldTypeKey;
  readonly page_number: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly required: boolean;
  /** A text tag's role (as typed, trimmed); null for a PDF form field or a tag without one. */
  readonly role: string | null;
  /** CHECKBOX / RADIO (the catalog's `label` setting; a radio button's option text), or a tag's label=. */
  readonly label: string | null;
  /** RADIO only: a radio group's buttons share one group (SELECT_ONE). */
  readonly group_key: string | null;
  readonly group_rule: 'SELECT_ONE' | null;
  /** FIELD-PARITY-2 A-5 — DROPDOWN only: the PDF dropdown's choices ({ choices }); null otherwise. */
  readonly options: FieldOptions | null;
}

export const FIELD_IMPORT_WARNING_CODES = [
  'pdf_field_type_unsupported',
  'pdf_field_list_as_text',
  'pdf_field_dropdown_as_text',
  'pdf_field_type_not_allowed',
  'pdf_field_read_only',
  'pdf_field_hidden',
  'pdf_field_signed',
  'pdf_field_not_on_page',
  'text_tag_invalid',
  'text_tag_type_unknown',
  'text_tag_type_not_allowed',
  'text_tag_option_unknown',
  'text_tag_label_not_applicable',
  'text_tag_rotated_page',
  'text_tags_unreadable',
  'text_tag_text_not_removed',
  'text_tag_role_missing',
  'text_tag_role_unknown',
  'field_assigned_to_first_recipient',
  'too_many_fields',
] as const;
export type FieldImportWarningCode = (typeof FIELD_IMPORT_WARNING_CODES)[number];

export interface FieldImportWarning {
  readonly code: FieldImportWarningCode;
  readonly message: string;
  /** The form field name or the tag text the warning is about (absent: the whole import). */
  readonly name?: string;
  readonly page_number?: number;
}

export interface PageSize {
  readonly width: number;
  readonly height: number;
}

export interface FieldBox {
  readonly page_number: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

// isFieldTypeOn without narrowing the caller's variable (a type guard over every surface
// would narrow a FieldTypeKey to the types common to all of them).
const acceptedOn = (surface: FieldSurface, type: FieldTypeKey): boolean => isFieldTypeOn(surface, type);

/**
 * A box grown to IMPORT_MIN_FIELD_SIZE each way (up and to the right), then kept inside the
 * page (moved back in from the right / top edge; never past the left / bottom edge).
 */
export function fitImportBox(box: FieldBox, page: PageSize): FieldBox {
  const width = Math.min(Math.max(box.width, IMPORT_MIN_FIELD_SIZE), page.width);
  const height = Math.min(Math.max(box.height, IMPORT_MIN_FIELD_SIZE), page.height);
  const x = Math.min(Math.max(box.x, 0), page.width - width);
  const y = Math.min(Math.max(box.y, 0), page.height - height);
  return { page_number: box.page_number, x: r2(x), y: r2(y), width: r2(width), height: r2(height) };
}

function clampText(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * A lower_snake key from a free name (the fixed-form field_key rule `^[a-z][a-z0-9_]{0,63}$`),
 * unique against `taken` (a `_2`, `_3`… suffix); the key is added to `taken`.
 */
export function importFieldKey(name: string, taken: Set<string>, max = 64): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(base)) base = `f_${base}`.replace(/_+$/, '');
  if (base === 'f') base = 'field';
  base = base.slice(0, max).replace(/_+$/, '');
  let key = base;
  for (let n = 2; taken.has(key); n += 1) {
    const suffix = `_${n}`;
    key = `${base.slice(0, max - suffix.length).replace(/_+$/, '')}${suffix}`;
  }
  taken.add(key);
  return key;
}

/** A check-box group key from a radio group's name, unique against `taken` (FIELD_GROUP_KEY_MAX). */
export function importGroupKey(name: string, taken: Set<string>): string {
  return importFieldKey(name, taken, FIELD_GROUP_KEY_MAX);
}

// ── P2-5 fillable-PDF (AcroForm) import ───────────────────────────────────────

/** The PDF form field kinds @aramo/documents-rendering reads. */
export const PDF_FORM_FIELD_KINDS = ['text', 'multiline_text', 'checkbox', 'radio', 'dropdown', 'list', 'signature', 'push_button'] as const;
export type PdfFormFieldKind = (typeof PDF_FORM_FIELD_KINDS)[number];

/**
 * P2-5 — the catalog type each PDF form field kind becomes (null: not imported).
 * FIELD-PARITY-1 P3 — a radio group becomes a RADIO group (T-5: each radio button one RADIO
 * option of a SELECT_ONE group, labelled with its option) and a multi-line text field a
 * MULTILINE_TEXT field (T-7). FIELD-PARITY-2 A-5 — a dropdown becomes a DROPDOWN with its
 * choices (options.choices) when they fit the catalog's rule (1 to 50 distinct choices; the
 * shared settings parser decides); otherwise it is imported as TEXT with the warning
 * pdf_field_dropdown_as_text. A list box (several may be chosen) becomes TEXT with the warning
 * pdf_field_list_as_text. A push button has no catalog equivalent.
 */
export const PDF_FORM_FIELD_MAPPING: Readonly<Record<PdfFormFieldKind, FieldTypeKey | null>> = {
  text: 'TEXT',
  multiline_text: 'MULTILINE_TEXT',
  checkbox: 'CHECKBOX',
  radio: 'RADIO',
  dropdown: 'DROPDOWN',
  list: 'TEXT',
  signature: 'SIGNATURE',
  push_button: null,
};

/** One widget (one box on one page) of a PDF form field, as the reader found it. */
export interface PdfFormWidget {
  readonly kind: PdfFormFieldKind;
  /** The field's fully qualified name. */
  readonly name: string;
  /** The field's tooltip (/TU), when it has one. */
  readonly tooltip: string | null;
  readonly required: boolean;
  readonly read_only: boolean;
  /** The widget is hidden or not shown on screen. */
  readonly hidden: boolean;
  /** A signature field that already holds a signature. */
  readonly signed: boolean;
  /** A radio button's (or check box's) on-state value; null when it has none. */
  readonly option: string | null;
  /**
   * FIELD-PARITY-2 A-5 — a dropdown's / list box's choices (the PDF /Opt: export value and
   * display text); absent or null for any other kind.
   */
  readonly choices?: ReadonlyArray<{ readonly value: string; readonly label: string }> | null;
  /** null: the widget is on no page. */
  readonly page_number: number | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FieldImportPlan {
  readonly fields: ImportedField[];
  readonly warnings: FieldImportWarning[];
}

/**
 * FIELD-PARITY-2 A-5 — a PDF dropdown's choices as DROPDOWN options for `surface`, or null when
 * the surface takes no DROPDOWN or the choices do not fit the catalog's rule (the shared
 * settings parser, the same rule every field write passes).
 */
export function importDropdownOptions(choices: PdfFormWidget['choices'], surface: FieldSurface): FieldOptions | null {
  if (!acceptedOn(surface, 'DROPDOWN') || choices === undefined || choices === null) return null;
  const parsed = parseTemplateFieldSettings({ options: { choices: choices.map((c) => ({ value: c.value, label: c.label })) } }, 'DROPDOWN');
  return parsed.ok && parsed.settings.options !== null && parsed.settings.options !== undefined ? parsed.settings.options : null;
}

/**
 * P2-5 — the PDF form's widgets as catalog fields for `surface`. A field keeps its name; a
 * check box takes its tooltip (else its name) as its label; a radio group's buttons become one
 * RADIO group (FIELD-PARITY-1 P3 T-5) keyed by the radio name, each labelled with its option. Skipped, each with
 * a named warning: push buttons, read-only fields, hidden widgets, signatures already signed,
 * widgets on no page, and any type the surface does not accept. `groupKeysTaken` holds the
 * group keys already used where the fields will be stored (it is updated).
 */
export function planPdfFormFields(widgets: readonly PdfFormWidget[], pages: readonly PageSize[], surface: FieldSurface, groupKeysTaken: Set<string>): FieldImportPlan {
  const fields: ImportedField[] = [];
  const warnings: FieldImportWarning[] = [];
  const warnedFields = new Set<string>();
  const warnOnce = (w: FieldImportWarning): void => {
    const k = `${w.code}:${w.name ?? ''}`;
    if (warnedFields.has(k)) return;
    warnedFields.add(k);
    warnings.push(w);
  };
  const radioGroups = new Map<string, string>();
  for (const w of widgets) {
    let type = PDF_FORM_FIELD_MAPPING[w.kind];
    // FIELD-PARITY-2 A-5 — a dropdown keeps its choices when they fit; otherwise (and for a
    // list box) it is imported as TEXT, with a warning saying so.
    let options: FieldOptions | null = null;
    let asText: FieldImportWarning | null = null;
    if (type === 'DROPDOWN') {
      options = importDropdownOptions(w.choices, surface);
      if (options === null) {
        type = 'TEXT';
        asText = {
          code: 'pdf_field_dropdown_as_text',
          message: `"${w.name}" is a dropdown whose choices don't fit a dropdown field (1 to 50 distinct choices, each 1 to 100 characters); it was imported as a text field.`,
          name: w.name,
        };
      }
    } else if (w.kind === 'list') {
      asText = { code: 'pdf_field_list_as_text', message: `"${w.name}" is a list box; it was imported as a text field.`, name: w.name };
    }
    if (type === null) {
      warnOnce({ code: 'pdf_field_type_unsupported', message: `"${w.name}" is a push button; there is no field type for it.`, name: w.name });
      continue;
    }
    if (!acceptedOn(surface, type)) {
      warnOnce({ code: 'pdf_field_type_not_allowed', message: `"${w.name}" would be a ${type} field, which this document does not accept.`, name: w.name });
      continue;
    }
    if (w.signed) {
      warnOnce({ code: 'pdf_field_signed', message: `"${w.name}" is already signed; it is kept as printed, not imported.`, name: w.name });
      continue;
    }
    if (w.read_only) {
      warnOnce({ code: 'pdf_field_read_only', message: `"${w.name}" is read-only in the PDF; it is kept as printed, not imported.`, name: w.name });
      continue;
    }
    if (w.hidden) {
      warnOnce({ code: 'pdf_field_hidden', message: `"${w.name}" is hidden in the PDF; it is not imported.`, name: w.name });
      continue;
    }
    const page = w.page_number === null ? undefined : pages[w.page_number];
    if (w.page_number === null || page === undefined || w.width <= 0 || w.height <= 0) {
      warnOnce({ code: 'pdf_field_not_on_page', message: `"${w.name}" is not placed on a page; it is not imported.`, name: w.name });
      continue;
    }
    const box = fitImportBox({ page_number: w.page_number, x: w.x, y: w.y, width: w.width, height: w.height }, page);
    let label: string | null = null;
    let group_key: string | null = null;
    let group_rule: 'SELECT_ONE' | null = null;
    if (type === 'RADIO') {
      group_key = radioGroups.get(w.name) ?? importGroupKey(w.name, groupKeysTaken);
      radioGroups.set(w.name, group_key);
      group_rule = 'SELECT_ONE';
      label = clampText((w.option ?? w.tooltip ?? w.name).trim(), FIELD_LABEL_MAX) || null;
    } else if (type === 'CHECKBOX') {
      label = clampText((w.tooltip ?? w.name).trim(), FIELD_LABEL_MAX) || null;
    }
    if (asText !== null) warnOnce(asText);
    fields.push({ source: 'pdf_form', name: w.name, field_type: type, ...box, required: w.required, role: null, label, group_key, group_rule, options });
  }
  return { fields, warnings };
}

// ── P2-6 text tags ────────────────────────────────────────────────────────────

/**
 * The lower-case type names a tag may use (a catalog key in any case is accepted too).
 * "date" is the signing date (kept for compatibility) and "name" the signer's printed name.
 * FIELD-PARITY-1 P3 — the chosen date (T-3) is "date_chosen" (or "chosen_date"), multi-line
 * text (T-7) "multiline" / "multiline_text" / "paragraph", a number (T-6) "number", and the
 * acknowledgement (T-2) "acknowledgement" / "acknowledge". A tag cannot carry a dropdown's
 * choices or a radio button's group, so DROPDOWN and RADIO are not tag types
 * (TEXT_TAG_UNSUPPORTED_TYPES).
 */
export const TEXT_TAG_TYPE_ALIASES: Readonly<Record<string, FieldTypeKey>> = {
  signature: 'SIGNATURE',
  initials: 'INITIALS',
  date: 'SIGN_DATE',
  sign_date: 'SIGN_DATE',
  name: 'SIGNER_NAME',
  signer_name: 'SIGNER_NAME',
  text: 'TEXT',
  checkbox: 'CHECKBOX',
  title: 'TITLE',
  company: 'COMPANY',
  email: 'EMAIL',
  first_name: 'FIRST_NAME',
  last_name: 'LAST_NAME',
  date_chosen: 'DATE',
  chosen_date: 'DATE',
  multiline: 'MULTILINE_TEXT',
  multiline_text: 'MULTILINE_TEXT',
  paragraph: 'MULTILINE_TEXT',
  number: 'NUMBER',
  acknowledgement: 'ACKNOWLEDGEMENT',
  acknowledge: 'ACKNOWLEDGEMENT',
};

/**
 * FIELD-PARITY-1 P3 — catalog types a tag cannot create: a DROPDOWN needs its choices and a
 * RADIO its group, which the tag syntax does not carry (the field would be refused when stored).
 */
export const TEXT_TAG_UNSUPPORTED_TYPES: ReadonlySet<FieldTypeKey> = new Set<FieldTypeKey>(['DROPDOWN', 'RADIO']);

/** A tag: `{{` + 1..300 characters without braces + `}}`. */
export const TEXT_TAG_PATTERN = /\{\{([^{}]{1,300})\}\}/g;

export interface ParsedTextTag {
  readonly field_type: FieldTypeKey;
  readonly role: string | null;
  /** null: the catalog default for the type. */
  readonly required: boolean | null;
  readonly label: string | null;
}

export type TextTagParse =
  | { readonly ok: true; readonly tag: ParsedTextTag; readonly warnings: FieldImportWarning[] }
  | { readonly ok: false; readonly warning: FieldImportWarning };

/** The catalog type a tag's type word names (alias or catalog key, any case); null if none. */
export function textTagTypeOf(word: string): FieldTypeKey | null {
  const w = word.trim();
  const alias = TEXT_TAG_TYPE_ALIASES[w.toLowerCase()];
  if (alias !== undefined) return alias;
  const key = w.toUpperCase();
  return isFieldTypeKey(key) ? key : null;
}

/**
 * P2-6 — one tag's inside (between the braces): `type[:role][:required|optional][:label=…]`.
 * The label runs to the end of the tag (it may hold ':'). An unknown type, or one the
 * surface does not accept, refuses the tag (no field); an unknown option or a label on a type
 * that takes none is a warning (ignored).
 */
export function parseTextTag(inner: string, surface: FieldSurface): TextTagParse {
  const text = inner.trim();
  const parts = text.split(':');
  const typeWord = (parts[0] ?? '').trim();
  if (typeWord.length === 0) {
    return { ok: false, warning: { code: 'text_tag_invalid', message: `{{${text}}} has no field type.`, name: text } };
  }
  const field_type = textTagTypeOf(typeWord);
  if (field_type === null) {
    return { ok: false, warning: { code: 'text_tag_type_unknown', message: `{{${text}}}: "${typeWord}" is not a field type.`, name: text } };
  }
  if (!acceptedOn(surface, field_type)) {
    return { ok: false, warning: { code: 'text_tag_type_not_allowed', message: `{{${text}}}: a ${field_type} field is not accepted on this document.`, name: text } };
  }
  if (TEXT_TAG_UNSUPPORTED_TYPES.has(field_type)) {
    return {
      ok: false,
      warning: { code: 'text_tag_type_not_allowed', message: `{{${text}}}: a ${field_type} field can't be made from a tag (it needs its ${field_type === 'DROPDOWN' ? 'choices' : 'group'}); place it in the editor.`, name: text },
    };
  }
  const warnings: FieldImportWarning[] = [];
  const roleRaw = (parts[1] ?? '').trim();
  const role = roleRaw.length > 0 && !/^label=/i.test(roleRaw) ? roleRaw : null;
  let required: boolean | null = null;
  let label: string | null = null;
  const rest = role === null && roleRaw.length > 0 ? parts.slice(1) : parts.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const opt = (rest[i] ?? '').trim();
    if (/^label=/i.test(opt)) {
      label = [opt.slice('label='.length), ...rest.slice(i + 1)].join(':').trim();
      break;
    }
    const o = opt.toLowerCase();
    if (o === 'required') required = true;
    else if (o === 'optional') required = false;
    else if (o.length > 0) warnings.push({ code: 'text_tag_option_unknown', message: `{{${text}}}: "${opt}" is not a tag option; it is ignored.`, name: text });
  }
  if (label !== null) {
    if (!fieldSettingsOf(field_type).includes('label')) {
      warnings.push({ code: 'text_tag_label_not_applicable', message: `{{${text}}}: a ${field_type} field has no label; it is ignored.`, name: text });
      label = null;
    } else {
      label = clampText(label, FIELD_LABEL_MAX) || null;
    }
  }
  return { ok: true, tag: { field_type, role, required, label }, warnings };
}

/** A word of a page's text layer, in any top-left-origin frame (the text layer's is 0..1). */
export interface TagWord {
  readonly t: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A tag found on a page: its text and its glyph box (same frame as the words). */
export interface FoundTextTag {
  /** The tag's inside (between the braces). */
  readonly inner: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Every `{{…}}` tag on one page's words. Words are grouped into lines (by vertical centre),
 * joined left to right — with a space where there is a visible gap, without one where a
 * source split a word into pieces — and each tag's box is the span of its characters
 * (apportioned by character position inside a word, as the text layer does for runs).
 */
export function findTextTags(words: readonly TagWord[]): FoundTextTag[] {
  const sorted = [...words].filter((w) => w.t.length > 0).sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
  const lines: Array<{ cy: number; h: number; words: TagWord[] }> = [];
  for (const w of sorted) {
    const cy = w.y + w.h / 2;
    const last = lines[lines.length - 1];
    if (last !== undefined && Math.abs(cy - last.cy) <= Math.max(last.h, w.h) * 0.5) {
      last.words.push(w);
      continue;
    }
    lines.push({ cy, h: w.h, words: [w] });
  }
  const out: FoundTextTag[] = [];
  for (const line of lines) {
    const ws = line.words.sort((a, b) => a.x - b.x);
    // The joined line, and for each character the word it came from (-1: an inserted space).
    let s = '';
    const owner: Array<{ word: number; at: number }> = [];
    ws.forEach((w, i) => {
      const prev = ws[i - 1];
      if (prev !== undefined && w.x - (prev.x + prev.w) > Math.min(prev.h, w.h) * 0.15) {
        s += ' ';
        owner.push({ word: -1, at: 0 });
      }
      for (let c = 0; c < w.t.length; c += 1) owner.push({ word: i, at: c });
      s += w.t;
    });
    const re = new RegExp(TEXT_TAG_PATTERN.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (let c = m.index; c < m.index + m[0].length; c += 1) {
        const o = owner[c];
        if (o === undefined || o.word < 0) continue;
        const w = ws[o.word];
        if (w === undefined) continue;
        const cw = w.w / w.t.length;
        x0 = Math.min(x0, w.x + o.at * cw);
        x1 = Math.max(x1, w.x + (o.at + 1) * cw);
        y0 = Math.min(y0, w.y);
        y1 = Math.max(y1, w.y + w.h);
      }
      if (!Number.isFinite(x0) || !Number.isFinite(y0)) continue;
      out.push({ inner: m[1] ?? '', x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
  }
  return out;
}

/** One page's geometry: the media box size (the field frame) and the crop box (the text layer's view). */
export interface TagPageFrame {
  readonly width: number;
  readonly height: number;
  readonly view: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly rotation: number;
}

/** One page of the text layer: 1-based page number, words in 0..1 of the view, origin top-left. */
export interface TagTextPage {
  readonly page: number;
  readonly words: readonly TagWord[];
}

/** A text tag's glyph box in the field frame (points, bottom-left origin) — what gets covered. */
export function tagBoxToPdf(tag: FoundTextTag, pageIndex: number, frame: TagPageFrame): FieldBox {
  const vw = frame.view.width;
  const vh = frame.view.height;
  const x = frame.view.x + tag.x * vw;
  const y = frame.view.y + (1 - (tag.y + tag.h)) * vh;
  return { page_number: pageIndex, x, y, width: tag.w * vw, height: tag.h * vh };
}

/**
 * The field a tag becomes: the tag's box (grown to the minimum size, kept on the page); a
 * check box is a square as tall as the tag at the tag's left edge.
 */
export function tagFieldRect(field_type: FieldTypeKey, box: FieldBox, page: PageSize): FieldBox {
  if (field_type === 'CHECKBOX') {
    const side = Math.max(box.height, IMPORT_MIN_FIELD_SIZE);
    return fitImportBox({ page_number: box.page_number, x: box.x, y: box.y, width: side, height: side }, page);
  }
  return fitImportBox(box, page);
}

/** The white rectangle that covers a tag (ruling R-5): its glyph box plus TEXT_TAG_COVER_PAD, on the page. */
export function tagCoverRect(box: FieldBox, page: PageSize): FieldBox {
  const x = Math.max(0, box.x - TEXT_TAG_COVER_PAD);
  const y = Math.max(0, box.y - TEXT_TAG_COVER_PAD);
  const right = Math.min(page.width, box.x + box.width + TEXT_TAG_COVER_PAD);
  const top = Math.min(page.height, box.y + box.height + TEXT_TAG_COVER_PAD);
  return { page_number: box.page_number, x: r2(x), y: r2(y), width: r2(Math.max(0, right - x)), height: r2(Math.max(0, top - y)) };
}

/**
 * A tag that became a field: the rectangle that covers it and its text (FIELD-PARITY-2 A-6,
 * ruling C-8: the text is removed from the page, the rectangle is painted as a fallback).
 */
export interface TextTagCover extends FieldBox {
  /** The tag as drawn, braces included. */
  readonly text: string;
  /** The tag without braces (the field's `name`). */
  readonly name: string;
}

export interface TextTagPlan extends FieldImportPlan {
  /** The tags to remove and cover on the stored PDF (one per tag that became a field). */
  readonly covers: TextTagCover[];
}

/**
 * FIELD-PARITY-2 A-6 — the import summary's warning for each tag whose text could not be removed
 * from the PDF (it is still covered with white, but its text stays searchable). `notRemoved`
 * holds indexes into `covers`.
 */
export function tagTextNotRemovedWarnings(covers: readonly TextTagCover[], notRemoved: readonly number[]): FieldImportWarning[] {
  return notRemoved.flatMap((i) => {
    const c = covers[i];
    if (c === undefined) return [];
    return [{ code: 'text_tag_text_not_removed' as const, message: `{{${c.name}}}: tag text could not be removed; it is covered with white, but its text is still in the PDF.`, name: c.name, page_number: c.page_number }];
  });
}

/**
 * P2-6 — every tag of the text layer as a catalog field for `surface`, with the rectangle
 * that covers it. A refused tag (unknown / not-allowed type, empty) becomes no field and is
 * left visible, with a named warning. Tags on a rotated page are not read (warning). The
 * role is returned as typed: the host binds it.
 */
export function planTextTags(pages: readonly TagTextPage[], frames: readonly TagPageFrame[], surface: FieldSurface): TextTagPlan {
  const fields: ImportedField[] = [];
  const warnings: FieldImportWarning[] = [];
  const covers: TextTagCover[] = [];
  for (const p of pages) {
    const index = p.page - 1;
    const frame = frames[index];
    if (frame === undefined) continue;
    const tags = findTextTags(p.words);
    if (tags.length === 0) continue;
    if (frame.rotation % 360 !== 0) {
      warnings.push({ code: 'text_tag_rotated_page', message: `Page ${p.page} is rotated; its tags are not read.`, page_number: index });
      continue;
    }
    for (const t of tags) {
      const parsed = parseTextTag(t.inner, surface);
      if (!parsed.ok) {
        warnings.push({ ...parsed.warning, page_number: index });
        continue;
      }
      for (const w of parsed.warnings) warnings.push({ ...w, page_number: index });
      const { tag } = parsed;
      const box = tagBoxToPdf(t, index, frame);
      const rect = tagFieldRect(tag.field_type, box, frame);
      const name = t.inner.trim();
      if (tag.role === null) warnings.push({ code: 'text_tag_role_missing', message: `{{${name}}} names no role; the field is not assigned.`, name, page_number: index });
      fields.push({
        source: 'text_tag',
        name,
        field_type: tag.field_type,
        ...rect,
        required: tag.required ?? FIELD_DEFAULTS[tag.field_type].required,
        role: tag.role,
        label: tag.label,
        group_key: null,
        group_rule: null,
        options: null,
      });
      covers.push({ ...tagCoverRect(box, frame), text: `{{${t.inner}}}`, name });
    }
  }
  return { fields, warnings, covers };
}

/**
 * The role a tag names, matched case-insensitively against the host's role options (each with
 * the names it answers to: a fixed-form role's key and label, a recipient's name and email).
 * Returns the matching option's id, or null.
 */
export function matchTagRole<T extends { readonly id: string; readonly names: readonly (string | null | undefined)[] }>(role: string, options: readonly T[]): string | null {
  const want = role.trim().toLowerCase();
  if (want.length === 0) return null;
  const hit = options.find((c) => c.names.some((n) => typeof n === 'string' && n.trim().toLowerCase() === want));
  return hit?.id ?? null;
}
