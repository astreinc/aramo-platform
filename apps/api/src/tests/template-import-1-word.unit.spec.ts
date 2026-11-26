import {
  AlignmentType,
  Document,
  Footer,
  FootnoteReferenceRun,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalMergeType,
} from 'docx';
import JSZip from 'jszip';
import type { AuthContextType } from '@aramo/auth';
import type { TemplateAuditPort, TemplateCapabilitiesPort, TemplateVariablesRepository, TemplatesRepository } from '@aramo/documents';
import { describe, expect, it, vi } from 'vitest';

import { RTR_HTML_SCHEMA_V2, sanitizeRtrHtml } from '../rtr/rtr-html-content.js';
import { PlatformDocumentTemplatesController } from '../document-templates-platform/platform-document-templates.controller.js';
import { checkDocx, readZipDirectory } from '../document-templates-platform/word-import/docx-package.js';
import { convertDocx, fileTitle } from '../document-templates-platform/word-import/docx-to-content.js';
import { blockCounts, mapWordHtml } from '../document-templates-platform/word-import/map-word-html.js';
import { WordImportRefusedError } from '../document-templates-platform/word-import/word-import.constants.js';

// TEMPLATE-IMPORT-1 (Aramo-Template-Word-Import-Directive-v1_1-LOCKED) — the Word import's
// pure parts: the mapper (W-3), file safety (W-2) and the whole conversion on real .docx files
// built with the `docx` library.

const refusal = async (p: Promise<unknown> | (() => unknown)): Promise<string | null> => {
  try {
    await (typeof p === 'function' ? p() : p);
    return null;
  } catch (e) {
    return e instanceof WordImportRefusedError ? e.reason : `other:${String(e)}`;
  }
};

const canonical = (html: string) => {
  const r = sanitizeRtrHtml(html, () => true, RTR_HTML_SCHEMA_V2);
  if ('issue' in r) throw new Error(`sanitiser issue ${r.issue.reason}`);
  return r.html;
};

const docxBytes = async (children: ConstructorParameters<typeof Document>[0]['sections'][number]['children'], extra: Partial<ConstructorParameters<typeof Document>[0]> = {}, section: Record<string, unknown> = {}) =>
  new Uint8Array(await Packer.toBuffer(new Document({ ...extra, sections: [{ ...section, children }] })));

describe('W-3 — the mapper (mammoth html → rtr-html-v2)', () => {
  it('title, heading levels (4–6 merged with a warning), marks, links unwrapped, empties removed', () => {
    const r = mapWordHtml(
      '<p class="aramo-title">Employee Handbook</p><h1>Welcome</h1><h2>Hours</h2><h3>Breaks</h3><h5>Fine print</h5>' +
        '<p><strong>Bold</strong> <em>it</em> <u>u</u> <a href="https://x">link</a> {{company.name}}</p><p> </p><p><strong> </strong></p>',
    );
    expect(r.title).toBe('Employee Handbook');
    expect(r.html).toBe('<h2>Welcome</h2><h3>Hours</h3><h4>Breaks</h4><h4>Fine print</h4><p><b>Bold</b> <i>it</i> <u>u</u> link {{company.name}}</p>');
    expect(r.warnings).toEqual([{ code: 'heading_level_merged', count: 1, example: 'Fine print' }]);
    expect(canonical(r.html)).toBe(r.html);
  });

  it('lists keep two levels; a third is lifted after its parent item, with a warning', () => {
    const r = mapWordHtml('<ul><li>a<ul><li>b<ul><li>c</li><li>d</li></ul></li></ul></li><li>e</li></ul>');
    expect(r.html).toBe('<ul><li>a<ul><li>b</li><li>c</li><li>d</li></ul></li><li>e</li></ul>');
    expect(r.warnings).toEqual([{ code: 'list_level_lifted', count: 2, example: 'c' }]);
    expect(canonical(r.html)).toBe(r.html);
  });

  it('tables: header row from thead, cell blocks as lines, merged cells split into a grid', () => {
    const r = mapWordHtml(
      '<table><thead><tr><th><p>Benefit</p></th><th><p>Who</p></th><th><p>When</p></th></tr></thead>' +
        '<tbody><tr><td colspan="2"><p>PTO</p><p><strong>20</strong> days</p></td><td rowspan="2"><p>Yearly</p></td></tr>' +
        '<tr><td><p>Sick</p></td><td><p>All</p></td></tr></tbody></table>',
    );
    expect(r.html).toBe(
      '<table><tr><th>Benefit</th><th>Who</th><th>When</th></tr><tr><td>PTO<br><b>20</b> days</td><td></td><td>Yearly</td></tr><tr><td>Sick</td><td>All</td><td></td></tr></table>',
    );
    expect(r.warnings).toEqual([{ code: 'table_cells_unmerged', count: 2, example: 'PTO 20 days' }]);
    expect(canonical(r.html)).toBe(r.html);
  });

  it('a table wider than 8 columns becomes paragraphs; one longer than 200 rows is split with the header repeated', () => {
    const wide = mapWordHtml(`<table><tr>${Array.from({ length: 9 }, (_x, i) => `<td><p>c${i}</p></td>`).join('')}</tr></table>`);
    expect(wide.html).toBe(`<p>${Array.from({ length: 9 }, (_x, i) => `c${i}`).join(' · ')}</p>`);
    expect(wide.warnings).toEqual([{ code: 'table_flattened', count: 1, example: 'c0 c1 c2 c3 c4 c5 c6 c7 c8' }]);
    const long = mapWordHtml(`<table><tr><th><p>H</p></th></tr>${Array.from({ length: 250 }, (_x, i) => `<tr><td><p>r${i}</p></td></tr>`).join('')}</table>`);
    expect(blockCounts(long.html).table).toBe(2);
    const tables = long.html.split('</table>').filter((s) => s !== '');
    expect(tables.map((t) => (t.match(/<tr>/g) ?? []).length)).toEqual([200, 52]);
    expect(tables.every((t) => t.startsWith('<table><tr><th>H</th></tr>'))).toBe(true);
    expect(long.warnings).toEqual([{ code: 'table_split', count: 1, example: 'H' }]);
    expect(canonical(long.html)).toBe(long.html);
  });

  it('page breaks: inside a paragraph the paragraph is split; none at the start, end or doubled', () => {
    const r = mapWordHtml('<p><hr class="aramo-page-break" />one<hr class="aramo-page-break" />two</p><p><strong>x<hr class="aramo-page-break" />y</strong></p><hr class="aramo-page-break" />');
    expect(r.html).toBe('<p>one</p><hr data-break="page"><p>two</p><p><b>x</b></p><hr data-break="page"><p><b>y</b></p>');
    expect(canonical(r.html)).toBe(r.html);
  });

  it('images, notes and comment lists are dropped, with warnings', () => {
    const r = mapWordHtml(
      '<p>See<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup> <img src="" alt="Logo" /></p><ol><li id="footnote-1"><p>A note. <a href="#footnote-ref-1">↑</a></p></li></ol><dl></dl>',
      [{ code: 'comment_dropped', count: 2 }],
    );
    expect(r.html).toBe('<p>See</p>');
    expect(r.warnings).toEqual([
      { code: 'comment_dropped', count: 2 },
      { code: 'image_dropped', count: 1, example: 'Logo' },
      { code: 'note_dropped', count: 1, example: 'A note.' },
    ]);
  });

  it('counts blocks for the summary', () => {
    expect(blockCounts('<h2>a</h2><p>b</p><p>c</p><table><tr><td>x</td></tr></table><hr data-break="page"><ul><li>u</li></ul>')).toMatchObject({
      h2: 1,
      p: 2,
      table: 1,
      page_break: 1,
      ul: 1,
    });
  });
});

describe('W-2 — file safety', () => {
  it('refuses the wrong type, OLE (legacy .doc / encrypted), macros, a missing body, size and entry limits', async () => {
    const good = await docxBytes([new Paragraph('x')]);
    expect(await refusal(() => checkDocx('a.docx', good))).toBeNull();
    for (const name of ['a.doc', 'a.docm', 'a.dotx', 'a.rtf', 'a.pdf', 'a']) expect(await refusal(() => checkDocx(name, good))).toBe('import_file_type');
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(64).fill(0)]);
    expect(await refusal(() => checkDocx('a.docx', ole))).toBe('import_file_type');
    const enc = new Uint8Array([...ole, ...Buffer.from('EncryptedPackage', 'utf16le')]);
    expect(await refusal(() => checkDocx('a.docx', enc))).toBe('import_encrypted');
    expect(await refusal(() => checkDocx('a.docx', new Uint8Array(Buffer.from('{\\rtf1 hello}'))))).toBe('import_file_type');
    expect(await refusal(() => checkDocx('a.docx', new Uint8Array(10 * 1024 * 1024 + 1)))).toBe('import_too_large');

    const zip = async (files: Record<string, string>) => {
      const z = new JSZip();
      for (const [k, v] of Object.entries(files)) z.file(k, v);
      return new Uint8Array(await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
    };
    expect(await refusal(() => zip({ 'word/document.xml': '<x/>', 'word/vbaProject.bin': 'm' }).then((b) => checkDocx('a.docx', b)))).toBe('import_macros');
    expect(await refusal(() => zip({ 'other.xml': '<x/>' }).then((b) => checkDocx('a.docx', b)))).toBe('import_file_type');
    const many: Record<string, string> = { 'word/document.xml': '<x/>' };
    for (let i = 0; i < 2000; i++) many[`f${i}.txt`] = '';
    expect(await refusal(() => zip(many).then((b) => checkDocx('a.docx', b)))).toBe('import_too_many_entries');
    // 60 MB of zeros deflates to a few KB: refused on the declared unzipped size, never inflated.
    const bomb = new JSZip();
    bomb.file('word/document.xml', '<x/>');
    bomb.file('big.bin', new Uint8Array(60 * 1024 * 1024));
    const bombBytes = new Uint8Array(await bomb.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
    expect(bombBytes.byteLength).toBeLessThan(1024 * 1024);
    expect(await refusal(() => checkDocx('a.docx', bombBytes))).toBe('import_unzipped_too_large');
    expect(readZipDirectory(good).names).toContain('word/document.xml');
  }, 60_000);

  it('a conversion over the time limit is refused', async () => {
    const good = await docxBytes([new Paragraph('x')]);
    expect(await refusal(convertDocx('a.docx', good, 0))).toBe('import_timeout');
  });
});

describe('W-3 end to end — real .docx files', () => {
  it('a handbook-like document keeps its title, heading levels, lists, table, page break and placeholders', async () => {
    const bytes = await docxBytes(
      [
        new Paragraph({ text: 'Employee Handbook', heading: HeadingLevel.TITLE }),
        new Paragraph({ text: 'Welcome', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [new TextRun({ text: 'Bold', bold: true }), new TextRun(' and '), new TextRun({ text: 'under', underline: {} }), new TextRun(' for {{company.name}}.')] }),
        new Paragraph({ text: 'Hours', heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ text: 'Start', numbering: { reference: 'bul', level: 0 } }),
        new Paragraph({ text: 'Nested', numbering: { reference: 'bul', level: 1 } }),
        new Paragraph({ text: 'Too deep', numbering: { reference: 'bul', level: 2 } }),
        new Table({
          rows: [
            new TableRow({ tableHeader: true, children: [new TableCell({ children: [new Paragraph('Benefit')] }), new TableCell({ children: [new Paragraph('Who')] })] }),
            new TableRow({ children: [new TableCell({ children: [new Paragraph('PTO')] }), new TableCell({ children: [new Paragraph('All')] })] }),
          ],
        }),
        new Paragraph({ children: [new PageBreak()] }),
        new Paragraph({ text: 'Policies', heading: HeadingLevel.HEADING_4 }),
        new Paragraph({ children: [new TextRun('Note here'), new FootnoteReferenceRun(1)] }),
      ],
      {
        numbering: {
          config: [
            {
              reference: 'bul',
              levels: [0, 1, 2].map((level) => ({ level, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT })),
            },
          ],
        },
        footnotes: { 1: { children: [new Paragraph('The footnote.')] } },
      },
      { headers: { default: new Header({ children: [new Paragraph('Confidential')] }) }, footers: { default: new Footer({ children: [new Paragraph('Page')] }) } },
    );
    const r = await convertDocx('Handbook.docx', bytes);
    expect(r.title).toBe('Employee Handbook');
    expect(r.html).toBe(
      '<h2>Welcome</h2><p><b>Bold</b> and <u>under</u> for {{company.name}}.</p><h3>Hours</h3>' +
        '<ul><li>Start<ul><li>Nested</li><li>Too deep</li></ul></li></ul>' +
        '<table><tr><th>Benefit</th><th>Who</th></tr><tr><td>PTO</td><td>All</td></tr></table>' +
        '<hr data-break="page"><h4>Policies</h4><p>Note here</p>',
    );
    expect(canonical(r.html)).toBe(r.html);
    const codes = Object.fromEntries(r.warnings.map((x) => [x.code, x.count]));
    expect(codes).toEqual({ header_footer_dropped: 2, heading_level_merged: 1, list_level_lifted: 1, note_dropped: 1 });
  });

  it('a merged-cell table from Word is split into a grid', async () => {
    const bytes = await docxBytes([
      new Table({
        rows: [
          new TableRow({ children: [new TableCell({ columnSpan: 2, children: [new Paragraph('Wide')] }), new TableCell({ verticalMerge: VerticalMergeType.RESTART, children: [new Paragraph('Tall')] })] }),
          new TableRow({ children: [new TableCell({ children: [new Paragraph('a')] }), new TableCell({ children: [new Paragraph('b')] }), new TableCell({ verticalMerge: VerticalMergeType.CONTINUE, children: [new Paragraph('')] })] }),
        ],
      }),
    ]);
    const r = await convertDocx('t.docx', bytes);
    expect(r.html).toBe('<table><tr><td>Wide</td><td></td><td>Tall</td></tr><tr><td>a</td><td>b</td><td></td></tr></table>');
    expect(r.warnings).toEqual([{ code: 'table_cells_unmerged', count: 2, example: 'Wide' }]);
  });

  it('without a Title paragraph the file name is the title', async () => {
    const r = await convertDocx('C:\\docs\\Offer Letter.DOCX', await docxBytes([new Paragraph('Hi')]));
    expect(r.title).toBe('Offer Letter');
    expect(fileTitle('.docx')).toBe('Imported document');
  });
});

describe('W-1, W-4 … W-8 — the import route', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const TYPE = 'd0c50005-0000-7000-8000-000000000001';
  const platform = { sub: 'actor-1', consumer_type: 'platform', scopes: [], tenant_id: 't', actor_kind: 'user', iat: 0, exp: 0 } as unknown as AuthContextType;

  const build = (opts: { kind?: string; configurable?: boolean; versions?: Array<{ id: string; status: string }>; normalize?: (fs: { html: string; title: string }) => unknown } = {}) => {
    const templates = {
      getPlatformTemplate: vi.fn(async () => ({ id: ID, document_type_id: TYPE, template_kind: opts.kind ?? 'GENERATED' })),
      listPlatformVersions: vi.fn(async () => opts.versions ?? []),
      createPlatformVersion: vi.fn(async (i: Record<string, unknown>) => ({ id: 'v-new', status: 'DRAFT', version_number: 1, ...i })),
    };
    const caps = {
      isConfigurable: vi.fn(async () => opts.configurable ?? true),
      // The real normaliser chips known keys; here talent.* is known.
      normalizeDraftContent: vi.fn(async (i: { field_schema: { html: string; title: string } }) =>
        opts.normalize !== undefined
          ? opts.normalize(i.field_schema)
          : { ...i.field_schema, html: i.field_schema.html.replace(/\{\{(talent\.[a-z_]+)\}\}/g, '<span data-field="$1"></span>') },
      ),
    };
    const audit = { recordPlatformImport: vi.fn(async () => undefined) };
    const c = new PlatformDocumentTemplatesController(
      templates as unknown as TemplatesRepository,
      {} as unknown as TemplateVariablesRepository,
      caps as unknown as TemplateCapabilitiesPort,
      audit as unknown as TemplateAuditPort,
    );
    return { c, templates, caps, audit };
  };
  const body = async (children: Paragraph[], filename = 'Handbook.docx') => ({
    filename,
    content_base64: Buffer.from(await docxBytes(children)).toString('base64'),
  });
  const reasonOf = (p: Promise<unknown>) => p.then(() => null, (e: { statusCode?: number; context?: { details?: { reason?: string } } }) => `${e.statusCode}:${e.context?.details?.reason ?? ''}`);

  it('creates a v2 DRAFT through the normaliser, returns the summary, and audits file facts only', async () => {
    const { c, templates, audit } = build();
    const b = await body([
      new Paragraph({ text: 'Offer', heading: HeadingLevel.TITLE }),
      new Paragraph({ text: 'Terms', heading: HeadingLevel.HEADING_1 }),
      new Paragraph('Dear {{talent.first_name}}, contact {{hr_contact}} or {{hr_contact}}.'),
    ]);
    const res = (await c.importWord(ID, b, platform, 'r')) as { version: { id: string }; summary: Record<string, unknown> };
    expect(templates.createPlatformVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        template_id: ID,
        // TEMPLATE-FIELDS-1 F-1 — the current version is v3 (the imported content is unchanged).
        render_schema_version: 'rtr-html-v3',
        field_schema: {
          render_schema_version: 'rtr-html-v3',
          title: 'Offer',
          html: '<h2>Terms</h2><p>Dear <span data-field="talent.first_name"></span>, contact {{hr_contact}} or {{hr_contact}}.</p>',
        },
      }),
    );
    expect(res.version.id).toBe('v-new');
    expect(res.summary).toMatchObject({
      title: 'Offer',
      counts: { h2: 1, p: 1 },
      warnings: [],
      unknown_placeholders: [{ key: 'hr_contact', count: 2 }],
    });
    const ev = (audit.recordPlatformImport.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(ev).toMatchObject({ template_id: ID, version_id: 'v-new', source_filename: 'Handbook.docx', document_type_id: TYPE });
    expect(ev['source_sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ev)).not.toContain('Dear');
  });

  it('refuses: an open draft (409 draft_exists), a fixed form, a non-configurable type, a bad file, too much content', async () => {
    const b = await body([new Paragraph('x')]);
    expect(await reasonOf(build({ versions: [{ id: 'd', status: 'DRAFT' }] }).c.importWord(ID, b, platform, 'r'))).toBe('409:draft_exists');
    expect(await reasonOf(build({ kind: 'UPLOADED_PDF' }).c.importWord(ID, b, platform, 'r'))).toBe('422:import_not_editable');
    expect(await reasonOf(build({ configurable: false }).c.importWord(ID, b, platform, 'r'))).toBe('422:import_not_editable');
    expect(await reasonOf(build().c.importWord(ID, { ...b, filename: 'a.docm' }, platform, 'r'))).toBe('422:import_file_type');
    expect(await reasonOf(build().c.importWord(ID, { filename: 'a.docx', content_base64: 'A'.repeat(14 * 1024 * 1024) }, platform, 'r'))).toBe('422:import_too_large');
    const big = await body([new Paragraph('y'.repeat(300 * 1024))]);
    const huge = build();
    expect(await reasonOf(huge.c.importWord(ID, big, platform, 'r'))).toBe('422:content_too_large');
    expect(huge.templates.createPlatformVersion).not.toHaveBeenCalled();
    expect(await reasonOf(build().c.importWord(ID, { filename: 'a.docx' }, platform, 'r'))).toBe('400:content_required');
  });

  it('a tenant token is refused before anything is read', async () => {
    const { c, templates } = build();
    expect(await reasonOf(c.importWord(ID, await body([new Paragraph('x')]), { ...platform, consumer_type: 'recruiter' } as AuthContextType, 'r'))).toBe('403:tier_mismatch');
    expect(templates.getPlatformTemplate).not.toHaveBeenCalled();
  });
});
