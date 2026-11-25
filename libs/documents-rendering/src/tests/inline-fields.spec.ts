// TEMPLATE-FIELDS-1 F-8 / F-9 / F-11 — inline Sign field boxes in rich content: laid out in the
// text, never split, the line grows to the tallest box, positions recorded exactly; a box wider
// than its space is refused; content without boxes is unchanged (the C-10 goldens in
// rendering.spec.ts), and content with boxes has its own goldens here.
import { describe, expect, it } from 'vitest';
import { PdfLibDocumentRenderingAdapter, InlineFieldTooWideError, inlineFieldMaxWidth, layoutRuns, type RenderModel, type RichRun } from '../index.js';

const adapter = new PdfLibDocumentRenderingAdapter();

const SIG: RichRun = { kind: 'field', field_key: 'employee_signature', width: 230, height: 50 };
const INI: RichRun = { kind: 'field', field_key: 'employee_initials', width: 60, height: 30 };
const BOX: RichRun = { kind: 'field', field_key: 'policy_ack', width: 18, height: 18 };

function model(rich_blocks: RenderModel['rich_blocks']): RenderModel {
  return {
    template_version_id: '00000000-0000-7000-8000-0000000000f1',
    render_schema_version: 'rich-v1',
    title: 'Employee Handbook',
    blocks: [],
    rich_blocks,
    heading_keep_with_next: true,
  };
}

// Geometry of the rich path (US Letter): margins 54, title 18pt, body 11pt × 1.4.
const MARGIN_X = 54;
const BODY = 11;
const LINE = BODY * 1.4;

describe('inline field boxes (TEMPLATE-FIELDS-1 F-8)', () => {
  it('the space a box may use: content, list item and table cell widths', () => {
    expect(inlineFieldMaxWidth({ in: 'paragraph' })).toBe(504);
    expect(inlineFieldMaxWidth({ in: 'list', level: 0 })).toBe(486);
    expect(inlineFieldMaxWidth({ in: 'list', level: 1 })).toBe(468);
    expect(inlineFieldMaxWidth({ in: 'table', columns: 2 })).toBe(244);
    expect(inlineFieldMaxWidth({ in: 'table', columns: 8 })).toBe(55);
  });

  it('a box inline in a paragraph: drawn after the text on the same line, position recorded', async () => {
    const out = await adapter.renderGenerated(model([{ kind: 'paragraph', runs: [{ text: 'Signed: ' }, SIG] }]));
    expect(out.inline_fields).toHaveLength(1);
    const f = out.inline_fields![0]!;
    expect(f).toMatchObject({ field_key: 'employee_signature', page_number: 0, width: 230, height: 50 });
    // x = margin + width("Signed:") + one space, measured in Helvetica 11pt.
    expect(f.x).toBeGreaterThan(MARGIN_X + 30);
    expect(f.x).toBeLessThan(MARGIN_X + 50);
    // The line grew: its baseline moved down by height - 3 - 11 = 36pt, the box sits 3pt under it.
    const repeat = await adapter.renderGenerated(model([{ kind: 'paragraph', runs: [{ text: 'Signed: ' }, SIG] }]));
    expect(repeat.inline_fields).toEqual(out.inline_fields);
    expect(repeat.sha256).toBe(out.sha256);
  });

  it('variable line height: the line holding a taller box moves the following text further down', async () => {
    const plain = await adapter.renderGenerated(model([{ kind: 'paragraph', runs: [{ text: 'A ' }, BOX] }, { kind: 'paragraph', runs: [{ text: 'B ' }, SIG] }]));
    const [check, sig] = plain.inline_fields!;
    // Checkbox 18pt: extra = 18 - 3 - 11 = 4. Signature 50pt: extra = 36.
    // Paragraph 1 baseline = Y0 - 4; paragraph 2 baseline = Y0 - 4 - LINE - 6 (block gap) - 36.
    const base1 = check!.y + 3;
    const base2 = sig!.y + 3;
    expect(base1 - base2).toBeCloseTo(LINE + 6 + 36, 6);
  });

  it('a box in a list item and in a table cell', async () => {
    const out = await adapter.renderGenerated(
      model([
        { kind: 'list', ordered: false, items: [{ runs: [{ text: 'I have read the policy ' }, BOX], children: [] }] },
        { kind: 'table', header: false, rows: [[[{ text: 'Initials' }], [INI]]] },
      ]),
    );
    const [li, cell] = out.inline_fields!;
    expect(li!.field_key).toBe('policy_ack');
    // List item text starts at margin + 18 (marker column).
    expect(li!.x).toBeGreaterThan(MARGIN_X + 18);
    expect(cell!.field_key).toBe('employee_initials');
    // Second column of a 2-column table: x = margin + 252 + 4 (cell padding).
    expect(cell!.x).toBeCloseTo(MARGIN_X + 252 + 4, 6);
    expect(cell!.page_number).toBe(0);
  });

  it('a box that does not fit on the line moves whole to the next line', async () => {
    const box: RichRun = { kind: 'field', field_key: 'employee_initials', width: 60, height: 30 };
    // "aaaa bbbb" = 45 at 5/char; + space 5 + box 60 = 110 > 100: the box moves, unsplit.
    const lines = layoutRuns([{ text: 'aaaa bbbb ' }, box, { text: ' cc' }], (t) => t.length * 5, 100);
    expect(lines.map((l) => l.map((s) => s.box?.field_key ?? s.text))).toEqual([['aaaa', 'bbbb'], ['employee_initials', 'cc']]);
    // It fits: it stays on the line, after a space.
    const fits = layoutRuns([{ text: 'aa ' }, box], (t) => t.length * 5, 100);
    expect(fits).toHaveLength(1);
    expect(fits[0]![1]!.space_before).toBe(true);
  });

  it('a box that does not fit on the page moves whole to the next page (never split)', async () => {
    const filler = { kind: 'paragraph' as const, runs: [{ text: 'The employee acknowledges the handbook. '.repeat(118) }] };
    const out = await adapter.renderGenerated(model([filler, { kind: 'paragraph', runs: [{ text: 'Signed: ' }, SIG] }]));
    const f = out.inline_fields![0]!;
    expect(out.page_count).toBe(2);
    expect(f.page_number).toBe(1);
    // Whole box inside the page, above the bottom margin.
    expect(f.y).toBeGreaterThanOrEqual(54 - 3);
    expect(f.y + f.height).toBeLessThanOrEqual(792);
  });

  it('field_too_wide: a box wider than its space fails the render (nothing shrinks)', async () => {
    const wide: RichRun = { kind: 'field', field_key: 'too_wide', width: 230, height: 50 };
    const eightCols = Array.from({ length: 8 }, (_v, i) => (i === 0 ? [wide] : [{ text: 'x' }]));
    await expect(adapter.renderGenerated(model([{ kind: 'table', header: false, rows: [eightCols] }]))).rejects.toBeInstanceOf(InlineFieldTooWideError);
    await expect(adapter.renderGenerated(model([{ kind: 'table', header: false, rows: [eightCols] }]))).rejects.toThrow(/field_too_wide: too_wide/);
  });

  it('the manifest hash covers the recorded positions; content without boxes reports none', async () => {
    const without = await adapter.renderGenerated(model([{ kind: 'paragraph', runs: [{ text: 'Signed: ' }] }]));
    expect(without.inline_fields).toBeUndefined();
    const a = await adapter.renderGenerated(model([{ kind: 'paragraph', runs: [{ text: 'Signed: ' }, SIG] }]));
    const b = await adapter.renderGenerated(model([{ kind: 'paragraph', runs: [{ text: 'Signed by the employee: ' }, SIG] }]));
    expect(a.inline_fields![0]!.x).not.toBe(b.inline_fields![0]!.x);
    expect(a.provenance.render_manifest_sha256).not.toBe(b.provenance.render_manifest_sha256);
  });

  // F-11 — goldens for content WITH fields (captured from this implementation; content without
  // fields keeps the C-10 goldens in rendering.spec.ts unchanged).
  it('goldens: content with inline fields', async () => {
    const handbook = model([
      { kind: 'heading', runs: [{ text: 'Acknowledgement' }] },
      { kind: 'paragraph', runs: [{ text: 'I have read the Employee Handbook. Initials: ' }, INI] },
      { kind: 'list', ordered: true, items: [{ runs: [{ text: 'I accept the IT policy ' }, BOX], children: [] }] },
      { kind: 'table', header: true, rows: [[[{ text: 'Employee' }], [{ text: 'Date' }]], [[SIG], [{ text: '' }]]] },
      { kind: 'paragraph', runs: [{ text: 'Signed: ' }, SIG] },
    ]);
    const out = await adapter.renderGenerated(handbook);
    expect(out.inline_fields!.map((f) => f.field_key)).toEqual(['employee_initials', 'policy_ack', 'employee_signature', 'employee_signature']);
    expect(out.sha256).toBe(GOLDEN_HANDBOOK);
    expect(out.provenance.render_manifest_sha256).toBe(GOLDEN_HANDBOOK_MANIFEST);
  });
});

const GOLDEN_HANDBOOK = '8cf6bba4634c99fce20994776d9fda7426bf05f7d72a48203d4b5033e7cf8579';
const GOLDEN_HANDBOOK_MANIFEST = '152ee51506c20ff976b53ff76ffd01eae702f666309c83529b016703493f9f44';
