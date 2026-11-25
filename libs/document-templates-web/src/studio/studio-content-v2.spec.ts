import { describe, expect, it } from 'vitest';

import { blocksToHtml, htmlToBlocks, sanitizeDocHtml } from '../dt-html';
import {
  STUDIO_BLOCK_KINDS,
  STUDIO_TEXT_KINDS,
  chipTokenBeforeCaret,
  chipTypedPlaceholder,
  createStudioCodec,
  indentStudioListItem,
  isCanonicalStudioHtml,
  makeStudioTable,
  outdentStudioListItem,
  parseStudioTable,
  renderStudioBlockDom,
  serializeStudioBlockDom,
  studioBlockText,
  studioBlocksFromHtml,
  studioBlocksToHtml,
  studioPreviewParts,
  studioTableValue,
  studioTypedPlaceholderKeys,
  type StudioBlock,
  type StudioChipResolver,
} from '../studio-codec';
import { RTR_HTML_SCHEMA_V2 } from '../document-templates-api';

import { contentRefusalMessage } from './content-refusals';
import { STUDIO_HTML_CONTENT_VERSION, studioHtmlContentOf } from './data-source';
import { convertTypedPlaceholderEverywhere, makeBlock, placeBlock, setBlockKind } from './doc-ops';
import { paginate } from './pagination';
import { deriveReadiness, type ReadinessInput } from './readiness';
import { TABLE_MAX_COLUMNS, TABLE_MAX_ROWS, addColumn, addRow, clampTableSize, removeColumn, removeRow, setHeader, stepCell } from './table-ops';

// TEMPLATE-CONTENT-2 (Aramo-Template-Content-2-Directive-v1_0-LOCKED) — the Studio side:
// loading (C-15), kinds (C-12), tables (C-13), lists (C-14), page breaks in the preview (C-11),
// typed placeholders (C-16 … C-18) and the refusal copy (§3.8).

const resolve: StudioChipResolver = (key) => ({ state: key.startsWith('talent.') ? 'known' : 'unknown', title: key });
let n = 0;
const newId = () => `b${++n}`;
const blk = (kind: StudioBlock['kind'], value: string): StudioBlock => ({ id: newId(), kind, value });

describe('C-15 — loading content', () => {
  it('v1 sanitising is unchanged: v2 tags flatten, nested lists flatten', () => {
    expect(sanitizeDocHtml('<h3>S</h3><table><tr><td>c</td></tr></table><hr><ul><li>a<ul><li>b</li></ul></li></ul>')).toBe(
      '<h2>S</h2><p>c</p><ul><li>ab</li></ul>',
    );
  });

  it('v2 keeps h3 / h4, tables, dividers, page breaks and two list levels', () => {
    const html = '<h2>A</h2><h3>B</h3><h4>C</h4><table><tr><th>H</th><th>I</th></tr><tr><td><b>x</b></td><td>y</td></tr></table><hr><hr data-break="page"><ul><li>a<ol><li>b</li></ol></li></ul>';
    expect(sanitizeDocHtml(html, { version: 'rtr-html-v2' })).toBe(html);
    expect(isCanonicalStudioHtml(html)).toBe(true);
  });

  it('v2: a third list level is lifted into the second (never dropped); thead / tbody unwrap; ragged rows pad', () => {
    expect(sanitizeDocHtml('<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>', { version: 'rtr-html-v2' })).toBe(
      '<ul><li>a<ul><li>b</li><li>c</li></ul></li></ul>',
    );
    expect(sanitizeDocHtml('<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>', { version: 'rtr-html-v2' })).toBe(
      '<table><tr><th>H</th><th></th></tr><tr><td>1</td><td>2</td></tr></table>',
    );
  });

  it('blocks round-trip through the v2 model, the divider and page break included', () => {
    const html = '<p>x</p><table><tr><td>a</td></tr></table><hr><hr data-break="page"><h4>t</h4>';
    const { blocks } = htmlToBlocks(html, 'rtr-html-v2');
    expect(blocks.map((b) => b.kind)).toEqual(['p', 'table', 'hr', 'page_break', 'h4']);
    expect(blocksToHtml(false, blocks)).toBe(html);
    expect(studioBlocksToHtml(studioBlocksFromHtml(html, newId))).toBe(html);
  });

  it('the Studio writes v2 and reads v1 and v2 content', () => {
    expect(STUDIO_HTML_CONTENT_VERSION).toBe(RTR_HTML_SCHEMA_V2);
    const fs = { title: 'T', html: '<p>x</p>' };
    expect(studioHtmlContentOf({ render_schema_version: 'rtr-html-v1', field_schema: { ...fs, render_schema_version: 'rtr-html-v1' } })).toEqual(fs);
    expect(studioHtmlContentOf({ render_schema_version: 'rtr-html-v2', field_schema: { ...fs, render_schema_version: 'rtr-html-v2' } })).toEqual(fs);
    expect(studioHtmlContentOf({ render_schema_version: 'rtr-html-v9', field_schema: fs })).toBeNull();
  });
});

describe('C-12 — kinds', () => {
  it('come from the shared rules; text kinds convert, the others never do', () => {
    expect(STUDIO_BLOCK_KINDS).toEqual(['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'table', 'hr', 'page_break']);
    expect(STUDIO_TEXT_KINDS).toEqual(['p', 'h2', 'h3', 'h4', 'ul', 'ol']);
    const t = blk('table', studioTableValue(makeStudioTable(1, 1)));
    const p = blk('p', 'x');
    expect(setBlockKind([t, p], t.id, 'p')[0]).toBe(t);
    expect(setBlockKind([t, p], p.id, 'h3')[1]).toMatchObject({ kind: 'h3', value: 'x' });
    expect(setBlockKind([p], p.id, 'table')[0]).toBe(p);
  });

  it('an inserted table / divider replaces an empty line, otherwise goes below', () => {
    const empty = blk('p', '');
    const full = blk('p', 'x');
    const hr = makeBlock('hr');
    expect(placeBlock([empty], hr, empty.id).map((b) => b.kind)).toEqual(['hr']);
    expect(placeBlock([full], hr, full.id).map((b) => b.kind)).toEqual(['p', 'hr']);
    expect(makeBlock('page_break').value).toBe('');
    expect(parseStudioTable(makeBlock('table').value)).toEqual(makeStudioTable(3, 2, true));
  });

  it('block text for the outline / diff names dividers and page breaks', () => {
    expect(studioBlockText({ kind: 'hr', value: '' })).toBe('— Divider —');
    expect(studioBlockText({ kind: 'page_break', value: '' })).toBe('— Page break —');
    expect(studioBlockText({ kind: 'table', value: '<tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr>' })).toBe('A | B | 1 | 2');
  });
});

describe('C-13 — tables', () => {
  it('model ⇄ value: a header row is th cells; the default is 3 × 2 with a header', () => {
    const t = makeStudioTable(3, 2);
    expect(studioTableValue(t)).toBe('<tr><th></th><th></th></tr><tr><td></td><td></td></tr><tr><td></td><td></td></tr>');
    expect(parseStudioTable(studioTableValue(setHeader(t, false))).header).toBe(false);
  });

  it('rows and columns are added and removed; the last one deletes the table; the limits stop with a message', () => {
    const t = makeStudioTable(2, 2);
    const r = addRow(t, 0);
    expect('table' in r && r.table.rows.length).toBe(3);
    // Never above the header row.
    expect('table' in r && r.table.rows[0]).toEqual(['', '']);
    expect(removeRow(makeStudioTable(1, 2), 0)).toBeNull();
    expect(removeColumn(makeStudioTable(2, 1), 0)).toBeNull();
    expect(removeRow(t, 0)?.header).toBe(false);
    const c = addColumn(t, 1);
    expect('table' in c && c.table.rows[0]?.length).toBe(3);
    expect(addColumn(makeStudioTable(1, TABLE_MAX_COLUMNS), 0)).toEqual({ limit: `A table can have up to ${TABLE_MAX_COLUMNS} columns.` });
    expect(addRow(makeStudioTable(TABLE_MAX_ROWS, 1), 0)).toEqual({ limit: `A table can have up to ${TABLE_MAX_ROWS} rows.` });
    expect(clampTableSize(0, 99)).toEqual({ rows: 1, cols: TABLE_MAX_COLUMNS });
  });

  it('Tab order walks the cells row by row', () => {
    const t = makeStudioTable(2, 2);
    expect(stepCell(t, 0, 1, 1)).toEqual({ r: 1, c: 0 });
    expect(stepCell(t, 1, 1, 1)).toBeNull();
    expect(stepCell(t, 0, 0, -1)).toBeNull();
  });

  it('the editor draws labelled editable cells with chips and serialises them back', () => {
    const el = document.createElement('div');
    const value = '<tr><th>Benefit</th><th>Who</th></tr><tr><td><b>PTO</b> for <span data-field="talent.first_name"></span></td><td>All</td></tr>';
    renderStudioBlockDom(el, value, 'table', resolve);
    const cells = el.querySelectorAll('[data-cell]');
    expect(cells).toHaveLength(4);
    expect(cells[0]?.getAttribute('aria-label')).toBe('Header, column 1');
    expect(cells[2]?.getAttribute('aria-label')).toBe('Row 1, column 1');
    expect(cells[2]?.getAttribute('contenteditable')).toBe('true');
    expect(cells[2]?.querySelector('.pws-chip')?.textContent).toBe('{{talent.first_name}}');
    expect(serializeStudioBlockDom(el, 'table')).toBe(value);
    // The codec the canvas drives does the same.
    expect(createStudioCodec(resolve).serialize(el, { labelByToken: {}, tokenByLabel: {} }, 'table')).toBe(value);
  });
});

describe('C-14 — lists two levels deep', () => {
  const listEl = (value: string) => {
    const el = document.createElement('div');
    renderStudioBlockDom(el, value, 'ul', resolve);
    return el;
  };

  it('a nested list round-trips through the editor', () => {
    const v = '<li>a<ul><li>b</li></ul></li><li>c</li>';
    expect(serializeStudioBlockDom(listEl(v), 'ul')).toBe(v);
  });

  it('Tab indents under the item above; never past two levels; Shift+Tab outdents', () => {
    const el = listEl('<li>a</li><li>b</li><li>c</li>');
    const items = () => Array.from(el.querySelectorAll('li')) as HTMLElement[];
    expect(indentStudioListItem(items()[0] as HTMLElement, el)).toBe('no_prev');
    expect(indentStudioListItem(items()[1] as HTMLElement, el)).toBe('ok');
    expect(serializeStudioBlockDom(el, 'ul')).toBe('<li>a<ul><li>b</li></ul></li><li>c</li>');
    const b = items()[1] as HTMLElement;
    expect(indentStudioListItem(b, el)).toBe('too_deep');
    expect(indentStudioListItem(items()[2] as HTMLElement, el)).toBe('ok');
    expect(serializeStudioBlockDom(el, 'ul')).toBe('<li>a<ul><li>b</li><li>c</li></ul></li>');
    // Outdenting b brings c along as its sub-item.
    expect(outdentStudioListItem(b)).toBe(true);
    expect(serializeStudioBlockDom(el, 'ul')).toBe('<li>a</li><li>b<ul><li>c</li></ul></li>');
    expect(outdentStudioListItem(items()[0] as HTMLElement)).toBe(false);
  });

  it('turning a nested list into a paragraph keeps every item as a line', () => {
    const p = blk('ul', '<li>a<ul><li>b</li></ul></li>');
    expect(setBlockKind([p], p.id, 'p')[0]?.value).toBe('a<br>b');
  });
});

describe('C-11 — page breaks in the preview', () => {
  it('a page break ends its page; a trailing one leaves no empty page', () => {
    expect(paginate(['a', '', 'b'], null, [false, true, false])).toEqual([[0, 1], [2]]);
    expect(paginate(['a', ''], null, [false, true])).toEqual([[0, 1]]);
  });

  it('preview parts name the page break', () => {
    expect(studioPreviewParts('<p>a</p><hr data-break="page"><hr>').map((p) => p.kind)).toEqual(['p', 'page_break', 'hr']);
  });
});

describe('C-16 … C-18 — typed placeholders', () => {
  it('finds typed keys (chips excluded) and converts one into a chip', () => {
    const v = 'Dear {{talent.first_name}} and <span data-field="talent.last_name"></span>, call {{hr_contact}}';
    expect(studioTypedPlaceholderKeys(v)).toEqual(['talent.first_name', 'hr_contact']);
    expect(chipTypedPlaceholder('p', v, 'talent.first_name')).toBe(
      'Dear <span data-field="talent.first_name"></span> and <span data-field="talent.last_name"></span>, call {{hr_contact}}',
    );
    const blocks = [blk('p', v), blk('table', '<tr><td>{{talent.first_name}}</td></tr>')];
    expect(convertTypedPlaceholderEverywhere(blocks, 'talent.first_name').map((b) => b.value)).toEqual([
      'Dear <span data-field="talent.first_name"></span> and <span data-field="talent.last_name"></span>, call {{hr_contact}}',
      '<tr><td><span data-field="talent.first_name"></span></td></tr>',
    ]);
  });

  it('live: closing a known {{key}} turns it into a chip; an unknown key stays text', () => {
    const el = document.createElement('div');
    el.textContent = 'Hi {{talent.first_name}}';
    const text = el.firstChild as Text;
    const r = document.createRange();
    r.setStart(text, text.length);
    r.collapse(true);
    const chip = (k: string) => {
      const c = document.createElement('span');
      c.setAttribute('data-field', k);
      return c;
    };
    expect(chipTokenBeforeCaret(r, (k) => k.startsWith('talent.'), chip)).toBe('talent.first_name');
    expect(el.innerHTML).toBe('Hi <span data-field="talent.first_name"></span>');
    const el2 = document.createElement('div');
    el2.textContent = '{{hr_contact}}';
    const r2 = document.createRange();
    r2.setStart(el2.firstChild as Text, 14);
    r2.collapse(true);
    expect(chipTokenBeforeCaret(r2, (k) => k.startsWith('talent.'), chip)).toBeNull();
    expect(el2.innerHTML).toBe('{{hr_contact}}');
  });

  it('readiness blocks on typed placeholders (convert only when known) and unknown title tokens', () => {
    const input: ReadinessInput = {
      title: 'For {{nobody.here}} and {{talent.full_name}}',
      blocks: [blk('p', 'Hi {{talent.first_name}} from {{hr_contact}}')],
      chipState: (k) => (k.startsWith('talent.') ? 'known' : 'unknown'),
      dirty: false,
      savedRev: 1,
      previewedRev: 1,
      withdrawal: null,
    };
    const r = deriveReadiness(input);
    const typed = r.items.filter((i) => i.id.startsWith('typed:') || i.id.startsWith('title-typed:'));
    expect(typed.map((i) => [i.id, i.ok, i.severity, i.convertKey])).toEqual([
      ['typed:talent.first_name', false, 'fail', 'talent.first_name'],
      ['typed:hr_contact', false, 'fail', undefined],
      ['title-typed:nobody.here', false, 'fail', undefined],
    ]);
    expect(r.ready).toBe(false);
  });
});

describe('§3.8 — refusal copy', () => {
  it('words each content refusal once; anything else falls through', () => {
    const err = (details: Record<string, unknown>) => Object.assign(new Error('x'), { details });
    expect(contentRefusalMessage(err({ reason: 'content_version_downgrade' }))).toMatch(/newer editor\. Reload the page/);
    expect(contentRefusalMessage(err({ reason: 'unresolved_placeholder', keys: ['hr_contact'] }))).toBe(
      'Typed placeholders are never filled in: {{hr_contact}}. Convert them to variables or replace them before publishing.',
    );
    expect(contentRefusalMessage(err({ reason: 'table_too_large' }))).toBe(`A table can have up to ${TABLE_MAX_COLUMNS} columns and ${TABLE_MAX_ROWS} rows.`);
    expect(contentRefusalMessage(err({ reason: 'logo_asset_mismatch' }))).toBeNull();
    expect(contentRefusalMessage(new Error('plain'))).toBeNull();
  });
});
