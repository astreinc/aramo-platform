// FIELD-PARITY-1 P2-5 / P2-6 — the pure import rules: the AcroForm → catalog mapping, the tag
// parser, the tag finder, tag box → field rect and the cover rectangle. Runs under vitest and
// mobile Jest (globals only).
import {
  PDF_FORM_FIELD_KINDS,
  PDF_FORM_FIELD_MAPPING,
  TEXT_TAG_UNSUPPORTED_TYPES,
  fieldTypesFor,
  findTextTags,
  fitImportBox,
  importFieldKey,
  importGroupKey,
  matchTagRole,
  parseFieldSettings,
  parseTextTag,
  planPdfFormFields,
  planTextTags,
  tagBoxToPdf,
  tagCoverRect,
  tagFieldRect,
  textTagTypeOf,
  type PdfFormWidget,
  type TagPageFrame,
} from '../index.js';

const LETTER = { width: 612, height: 792 };
const widget = (o: Partial<PdfFormWidget>): PdfFormWidget => ({
  kind: 'text',
  name: 'Field',
  tooltip: null,
  required: false,
  read_only: false,
  hidden: false,
  signed: false,
  option: null,
  page_number: 0,
  x: 100,
  y: 600,
  width: 200,
  height: 20,
  ...o,
});

describe('P2-5 AcroForm → catalog mapping', () => {
  it('maps every PDF form kind (push button: none)', () => {
    expect(PDF_FORM_FIELD_MAPPING).toEqual({
      text: 'TEXT',
      // FIELD-PARITY-1 P3 — multi-line text and radio groups have their own types now.
      // FIELD-PARITY-2 A-5 — a dropdown is a DROPDOWN (with its choices when they fit).
      multiline_text: 'MULTILINE_TEXT',
      checkbox: 'CHECKBOX',
      radio: 'RADIO',
      dropdown: 'DROPDOWN',
      list: 'TEXT',
      signature: 'SIGNATURE',
      push_button: null,
    });
    expect([...PDF_FORM_FIELD_KINDS].sort()).toEqual(Object.keys(PDF_FORM_FIELD_MAPPING).sort());
  });

  it('every mapped type is accepted by both upload surfaces', () => {
    for (const t of Object.values(PDF_FORM_FIELD_MAPPING)) {
      if (t === null) continue;
      expect(fieldTypesFor('template_fixed_form')).toContain(t);
      expect(fieldTypesFor('send_web')).toContain(t);
    }
  });

  it('plans text, check box, radio group, dropdown and signature fields', () => {
    const plan = planPdfFormFields(
      [
        widget({ kind: 'text', name: 'Full name', required: true }),
        widget({ kind: 'multiline_text', name: 'Notes', height: 80 }),
        widget({ kind: 'checkbox', name: 'agree', tooltip: 'I agree', width: 12, height: 12 }),
        widget({ kind: 'radio', name: 'Colour', option: 'Red', x: 50, width: 12, height: 12 }),
        widget({ kind: 'radio', name: 'Colour', option: 'Blue', x: 80, width: 12, height: 12 }),
        widget({ kind: 'dropdown', name: 'State', choices: [{ value: 'NY', label: 'New York' }, { value: 'CA', label: 'California' }] }),
        widget({ kind: 'signature', name: 'Sig1', height: 40 }),
      ],
      [LETTER],
      'template_fixed_form',
      new Set(),
    );
    expect(plan.warnings).toEqual([]);
    expect(plan.fields.map((f) => [f.name, f.field_type, f.label, f.group_key, f.group_rule])).toEqual([
      ['Full name', 'TEXT', null, null, null],
      ['Notes', 'MULTILINE_TEXT', null, null, null],
      ['agree', 'CHECKBOX', 'I agree', null, null],
      ['Colour', 'RADIO', 'Red', 'colour', 'SELECT_ONE'],
      ['Colour', 'RADIO', 'Blue', 'colour', 'SELECT_ONE'],
      ['State', 'DROPDOWN', null, null, null],
      ['Sig1', 'SIGNATURE', null, null, null],
    ]);
    expect(plan.fields[0]).toMatchObject({ source: 'pdf_form', page_number: 0, x: 100, y: 600, width: 200, height: 20, required: true, role: null, options: null });
    expect(plan.fields[5]?.options).toEqual({ choices: [{ value: 'NY', label: 'New York' }, { value: 'CA', label: 'California' }] });
  });

  it('FIELD-PARITY-2 A-5 a dropdown keeps 1..50 valid choices; otherwise (and a list box) it is TEXT with a warning', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => ({ value: `v${i}`, label: '' }));
    const plan = planPdfFormFields(
      [
        widget({ kind: 'dropdown', name: 'One', choices: [{ value: ' only ', label: '' }] }),
        widget({ kind: 'dropdown', name: 'Fifty', choices: fifty }),
        widget({ kind: 'dropdown', name: 'TooMany', choices: [...fifty, { value: 'v50', label: '' }] }),
        widget({ kind: 'dropdown', name: 'None', choices: [] }),
        widget({ kind: 'dropdown', name: 'Unread' }),
        widget({ kind: 'dropdown', name: 'Dup', choices: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] }),
        widget({ kind: 'dropdown', name: 'Empty', choices: [{ value: 'a', label: 'A' }, { value: '', label: '' }] }),
        widget({ kind: 'dropdown', name: 'Long', choices: [{ value: 'x'.repeat(101), label: 'x' }] }),
        widget({ kind: 'list', name: 'Fruits', choices: [{ value: 'Apple', label: 'Apple' }] }),
      ],
      [LETTER],
      'send_web',
      new Set(),
    );
    expect(plan.fields.map((f) => [f.name, f.field_type])).toEqual([
      ['One', 'DROPDOWN'],
      ['Fifty', 'DROPDOWN'],
      ['TooMany', 'TEXT'],
      ['None', 'TEXT'],
      ['Unread', 'TEXT'],
      ['Dup', 'TEXT'],
      ['Empty', 'TEXT'],
      ['Long', 'TEXT'],
      ['Fruits', 'TEXT'],
    ]);
    // The shared settings rule: values trimmed, an empty label is the value.
    expect(plan.fields[0]?.options).toEqual({ choices: [{ value: 'only', label: 'only' }] });
    expect(plan.fields[1]?.options?.choices).toHaveLength(50);
    expect(plan.fields.slice(2).every((f) => f.options === null)).toBe(true);
    expect(plan.warnings.map((w) => [w.code, w.name])).toEqual([
      ['pdf_field_dropdown_as_text', 'TooMany'],
      ['pdf_field_dropdown_as_text', 'None'],
      ['pdf_field_dropdown_as_text', 'Unread'],
      ['pdf_field_dropdown_as_text', 'Dup'],
      ['pdf_field_dropdown_as_text', 'Empty'],
      ['pdf_field_dropdown_as_text', 'Long'],
      ['pdf_field_list_as_text', 'Fruits'],
    ]);
  });

  it('FIELD-PARITY-2 A-5 a skipped dropdown is not also reported as imported as text', () => {
    const plan = planPdfFormFields([widget({ kind: 'dropdown', name: 'Locked', read_only: true, choices: [] })], [LETTER], 'send_web', new Set());
    expect(plan.fields).toEqual([]);
    expect(plan.warnings.map((w) => w.code)).toEqual(['pdf_field_read_only']);
  });

  it('skips push buttons, read-only, hidden, signed and off-page fields with named warnings', () => {
    const plan = planPdfFormFields(
      [
        widget({ kind: 'push_button', name: 'Print' }),
        widget({ name: 'Total', read_only: true }),
        widget({ name: 'Secret', hidden: true }),
        widget({ kind: 'signature', name: 'Signed', signed: true }),
        widget({ name: 'Lost', page_number: null }),
        widget({ name: 'Ghost', page_number: 3 }),
      ],
      [LETTER],
      'send_web',
      new Set(),
    );
    expect(plan.fields).toEqual([]);
    expect(plan.warnings.map((w) => [w.code, w.name])).toEqual([
      ['pdf_field_type_unsupported', 'Print'],
      ['pdf_field_read_only', 'Total'],
      ['pdf_field_hidden', 'Secret'],
      ['pdf_field_signed', 'Signed'],
      ['pdf_field_not_on_page', 'Lost'],
      ['pdf_field_not_on_page', 'Ghost'],
    ]);
  });

  it('a radio group key does not reuse a group key already taken', () => {
    const taken = new Set(['colour']);
    const plan = planPdfFormFields([widget({ kind: 'radio', name: 'Colour', option: 'Red' })], [LETTER], 'send_web', taken);
    expect(plan.fields[0]?.group_key).toBe('colour_2');
    expect(taken.has('colour_2')).toBe(true);
  });

  it('grows a tiny widget to the minimum size and keeps it on the page', () => {
    expect(fitImportBox({ page_number: 0, x: 608, y: 790, width: 4, height: 4 }, LETTER)).toEqual({ page_number: 0, x: 604, y: 784, width: 8, height: 8 });
    expect(fitImportBox({ page_number: 0, x: -5, y: -5, width: 20, height: 20 }, LETTER)).toEqual({ page_number: 0, x: 0, y: 0, width: 20, height: 20 });
  });

  it('makes unique lower_snake keys', () => {
    const taken = new Set<string>();
    expect(importFieldKey('Full Name', taken)).toBe('full_name');
    expect(importFieldKey('Full  name!', taken)).toBe('full_name_2');
    expect(importFieldKey('1st line', taken)).toBe('f_1st_line');
    expect(importFieldKey('***', taken)).toBe('field');
    expect(importFieldKey('x'.repeat(80), taken)).toHaveLength(64);
    expect(importGroupKey('Colour', new Set())).toBe('colour');
  });
});

describe('P2-6 tag parser', () => {
  it('reads type, role, required / optional and label', () => {
    expect(parseTextTag('signature:Seller', 'send_web')).toEqual({ ok: true, warnings: [], tag: { field_type: 'SIGNATURE', role: 'Seller', required: null, label: null } });
    expect(parseTextTag('text:Buyer:required', 'send_web')).toMatchObject({ ok: true, tag: { field_type: 'TEXT', role: 'Buyer', required: true } });
    expect(parseTextTag('date:Chair:optional', 'send_web')).toMatchObject({ ok: true, tag: { field_type: 'SIGN_DATE', role: 'Chair', required: false } });
    expect(parseTextTag('checkbox:Buyer:required:label=Terms: accepted', 'send_web')).toMatchObject({ ok: true, tag: { field_type: 'CHECKBOX', label: 'Terms: accepted', required: true } });
    expect(parseTextTag(' name : Seller ', 'send_web')).toMatchObject({ ok: true, tag: { field_type: 'SIGNER_NAME', role: 'Seller' } });
    expect(parseTextTag('SIGNATURE:Seller', 'send_web')).toMatchObject({ ok: true, tag: { field_type: 'SIGNATURE' } });
    expect(parseTextTag('signature', 'send_web')).toMatchObject({ ok: true, tag: { role: null } });
  });

  it('maps every documented alias', () => {
    expect(['signature', 'initials', 'date', 'name', 'text', 'checkbox', 'title', 'company', 'email', 'first_name', 'last_name'].map(textTagTypeOf)).toEqual([
      'SIGNATURE',
      'INITIALS',
      'SIGN_DATE',
      'SIGNER_NAME',
      'TEXT',
      'CHECKBOX',
      'TITLE',
      'COMPANY',
      'EMAIL',
      'FIRST_NAME',
      'LAST_NAME',
    ]);
    expect(textTagTypeOf('payment')).toBe('PAYMENT');
    expect(textTagTypeOf('stamp')).toBeNull();
  });

  it('refuses unknown types and types the surface does not accept', () => {
    expect(parseTextTag('stamp:Seller', 'send_web')).toMatchObject({ ok: false, warning: { code: 'text_tag_type_unknown' } });
    // FIELD-PARITY-1 P3 T-1 — the profile types are now on the fixed-form surface; PAYMENT never is.
    expect(parseTextTag('title:Seller', 'template_fixed_form')).toMatchObject({ ok: true, tag: { field_type: 'TITLE' } });
    expect(parseTextTag('payment:Seller', 'template_fixed_form')).toMatchObject({ ok: false, warning: { code: 'text_tag_type_not_allowed' } });
    expect(parseTextTag('payment:Seller', 'send_web')).toMatchObject({ ok: false, warning: { code: 'text_tag_type_not_allowed' } });
    expect(parseTextTag('  ', 'send_web')).toMatchObject({ ok: false, warning: { code: 'text_tag_invalid' } });
  });

  it('warns on an unknown option; a label is kept (FIELD-PARITY-1 P3 S-1: every type takes a label)', () => {
    const p = parseTextTag('text:Buyer:bold:label=Name', 'send_web');
    expect(p.ok && p.tag.label).toBe('Name');
    expect(p.ok && p.warnings.map((w) => w.code)).toEqual(['text_tag_option_unknown']);
  });
});

describe('P2-6 tag finder and geometry', () => {
  it('finds a tag inside one word, across split pieces, and across spaces', () => {
    const tags = findTextTags([
      { t: 'Sign:{{signature:Seller}}', x: 0.1, y: 0.1, w: 0.25, h: 0.02 },
      { t: '{{text:', x: 0.1, y: 0.3, w: 0.07, h: 0.02 },
      { t: 'Buyer}}', x: 0.17, y: 0.3, w: 0.07, h: 0.02 },
      { t: '{{checkbox:Buyer:label=I', x: 0.1, y: 0.5, w: 0.2, h: 0.02 },
      { t: 'agree}}', x: 0.32, y: 0.5, w: 0.06, h: 0.02 },
    ]);
    expect(tags.map((t) => t.inner)).toEqual(['signature:Seller', 'text:Buyer', 'checkbox:Buyer:label=I agree']);
    // "Sign:" is 5 of 25 characters: the tag box starts 0.05 in.
    expect(tags[0]?.x).toBeCloseTo(0.15, 6);
    expect(tags[0]?.w).toBeCloseTo(0.2, 6);
    expect(tags[1]?.y).toBeCloseTo(0.3, 6);
    expect(tags[1]?.h).toBeCloseTo(0.02, 6);
    expect(tags[1]?.x).toBeCloseTo(0.1, 6);
    expect(tags[1]?.w).toBeCloseTo(0.14, 6);
  });

  it('converts a tag box to the field frame, sizes the field and the cover', () => {
    const frame: TagPageFrame = { width: 612, height: 792, view: { x: 0, y: 0, width: 612, height: 792 }, rotation: 0 };
    const box = tagBoxToPdf({ inner: 'x', x: 0.1, y: 0.5, w: 0.2, h: 0.0125 }, 0, frame);
    expect(box.x).toBeCloseTo(61.2, 6);
    expect(box.y).toBeCloseTo(386.1, 6);
    expect(box.width).toBeCloseTo(122.4, 6);
    expect(box.height).toBeCloseTo(9.9, 6);
    expect(tagFieldRect('SIGNATURE', box, frame)).toEqual({ page_number: 0, x: 61.2, y: 386.1, width: 122.4, height: 9.9 });
    expect(tagFieldRect('CHECKBOX', box, frame)).toEqual({ page_number: 0, x: 61.2, y: 386.1, width: 9.9, height: 9.9 });
    expect(tagFieldRect('TEXT', { ...box, height: 5 }, frame).height).toBe(8);
    expect(tagCoverRect(box, frame)).toEqual({ page_number: 0, x: 60.2, y: 385.1, width: 124.4, height: 11.9 });
    expect(tagCoverRect({ page_number: 0, x: 0, y: 0, width: 10, height: 10 }, frame)).toEqual({ page_number: 0, x: 0, y: 0, width: 11, height: 11 });
  });

  it('plans fields and covers; refused tags stay visible; rotated pages are not read', () => {
    const frame: TagPageFrame = { width: 612, height: 792, view: { x: 0, y: 0, width: 612, height: 792 }, rotation: 0 };
    const plan = planTextTags(
      [
        {
          page: 1,
          words: [
            { t: '{{signature:Seller}}', x: 0.1, y: 0.8, w: 0.2, h: 0.015 },
            { t: '{{stamp:Seller}}', x: 0.1, y: 0.6, w: 0.2, h: 0.015 },
            { t: '{{text}}', x: 0.1, y: 0.4, w: 0.1, h: 0.015 },
          ],
        },
        { page: 2, words: [{ t: '{{signature:Buyer}}', x: 0.1, y: 0.8, w: 0.2, h: 0.015 }] },
      ],
      [frame, { ...frame, rotation: 90 }],
      'send_web',
    );
    expect(plan.fields.map((f) => [f.field_type, f.role, f.required])).toEqual([
      ['TEXT', null, false],
      ['SIGNATURE', 'Seller', true],
    ]);
    expect(plan.covers).toHaveLength(2);
    expect(plan.warnings.map((w) => w.code).sort()).toEqual(['text_tag_role_missing', 'text_tag_rotated_page', 'text_tag_type_unknown']);
  });

  it('matches a role case-insensitively against any name of an option', () => {
    const c = [
      { id: 'r1', names: ['seller', 'Seller of record'] },
      { id: 'r2', names: ['Buyer', 'buyer@example.com'] },
    ];
    expect(matchTagRole('SELLER', c)).toBe('r1');
    expect(matchTagRole(' buyer@EXAMPLE.com ', c)).toBe('r2');
    expect(matchTagRole('Chair', c)).toBeNull();
  });
});

// FIELD-PARITY-1 P3 — the imported radio group satisfies the ONE settings rule as a RADIO
// group, and the new tag aliases (with DROPDOWN / RADIO refused as tags).
describe('P3 — imported radio groups and the new tag types', () => {
  it('an imported radio button passes the settings rule as one option of a SELECT_ONE group', () => {
    const plan = planPdfFormFields([widget({ kind: 'radio', name: 'Plan', option: 'Pro', width: 12, height: 12 })], [LETTER], 'send_web', new Set());
    const f = plan.fields[0]!;
    expect(parseFieldSettings({ label: f.label, group_key: f.group_key, group_rule: f.group_rule }, f.field_type)).toMatchObject({ ok: true, settings: { group_key: 'plan', group_rule: 'SELECT_ONE', label: 'Pro' } });
  });

  it('the new aliases name the P3 types; "date" stays the signing date', () => {
    expect(textTagTypeOf('date')).toBe('SIGN_DATE');
    expect(textTagTypeOf('date_chosen')).toBe('DATE');
    expect(textTagTypeOf('chosen_date')).toBe('DATE');
    expect(textTagTypeOf('multiline')).toBe('MULTILINE_TEXT');
    expect(textTagTypeOf('paragraph')).toBe('MULTILINE_TEXT');
    expect(textTagTypeOf('number')).toBe('NUMBER');
    expect(textTagTypeOf('acknowledgement')).toBe('ACKNOWLEDGEMENT');
    expect(parseTextTag('date_chosen:Buyer:required', 'template_fixed_form')).toMatchObject({ ok: true, tag: { field_type: 'DATE', role: 'Buyer', required: true } });
    expect(parseTextTag('multiline:Buyer:label=Notes', 'send_web')).toMatchObject({ ok: true, tag: { field_type: 'MULTILINE_TEXT', label: 'Notes' } });
  });

  it('a DROPDOWN or RADIO tag is refused (a tag cannot carry choices or a group)', () => {
    expect([...TEXT_TAG_UNSUPPORTED_TYPES].sort()).toEqual(['DROPDOWN', 'RADIO']);
    for (const t of ['dropdown:Buyer', 'RADIO:Buyer']) {
      expect(parseTextTag(t, 'send_web')).toMatchObject({ ok: false, warning: { code: 'text_tag_type_not_allowed' } });
    }
  });
});
