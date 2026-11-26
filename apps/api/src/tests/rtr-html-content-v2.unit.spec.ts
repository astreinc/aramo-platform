import { describe, expect, it } from 'vitest';

import { RTR_HTML_SCHEMA_V1, RTR_HTML_SCHEMA_V2, chipKnownTypedTokens, parseHtmlContent, sanitizeRtrHtml, serialize, toRichBlocks, typedPlaceholderKeys } from '../rtr/rtr-html-content.js';
import { RtrTemplateCapabilities } from '../rtr/rtr-template-capabilities.service.js';
import { RIGHT_TO_REPRESENT_TYPE_ID } from '../rtr/rtr-constants.js';

import { fakeCatalog } from './fixtures/rtr-seed-catalog.js';

// TEMPLATE-CONTENT-2 (Aramo-Template-Content-2-Directive-v1_0-LOCKED) — the rtr-html-v2 content
// rules on the server: the sanitiser (C-1, C-2), the readers (C-3), the write paths (C-4 … C-6)
// and the typed-placeholder rules (C-16, C-17).

const known = () => true;
const clean = (html: string, version = RTR_HTML_SCHEMA_V2) => {
  const r = sanitizeRtrHtml(html, known, version);
  if ('issue' in r) throw new Error(`unexpected issue ${r.issue.reason}`);
  return r;
};
const issueOf = (html: string, version = RTR_HTML_SCHEMA_V2) => {
  const r = sanitizeRtrHtml(html, known, version);
  return 'issue' in r ? r.issue.reason : null;
};

describe('C-1 / C-2 — the v2 sanitiser (v1 unchanged)', () => {
  it('v1 still discards the v2 tags (a table becomes its text, h3 its text)', () => {
    expect(clean('<h3>Sub</h3><table><tr><td>cell</td></tr></table><hr>', RTR_HTML_SCHEMA_V1).html).toBe('Subcell');
  });

  it('v2 keeps h3 / h4, tables, dividers and page breaks', () => {
    expect(clean('<h2>A</h2><h3>B</h3><h4>C</h4><hr><hr data-break="page">').html).toBe('<h2>A</h2><h3>B</h3><h4>C</h4><hr><hr data-break="page">');
    expect(clean('<table><thead><tr><th>Benefit</th><th>Who</th></tr></thead><tbody><tr><td>PTO</td><td>All</td></tr></tbody></table>').html).toBe(
      '<table><tr><th>Benefit</th><th>Who</th></tr><tr><td>PTO</td><td>All</td></tr></table>',
    );
  });

  it('only data-break="page" survives on hr; other attributes are stripped everywhere', () => {
    expect(clean('<hr data-break="column"><hr class="x" data-break="page"><table style="w"><tr><td colspan="2">x</td></tr></table>').html).toBe(
      '<hr><hr data-break="page"><table><tr><td>x</td></tr></table>',
    );
  });

  it('a cell keeps inline content only: blocks become lines, a nested table its text, a divider is dropped', () => {
    expect(clean('<table><tr><td><p>One</p><p><b>Two</b></p><hr><table><tr><td>inner</td></tr></table></td></tr></table>').html).toBe(
      '<table><tr><td>One<br><b>Two</b><br>inner</td></tr></table>',
    );
  });

  it('rows / cells outside a table are unwrapped; an empty table is dropped', () => {
    expect(clean('<tr><td>stray</td></tr><table></table><p>x</p>').html).toBe('stray<p>x</p>');
  });

  it('limits: 8 columns, 200 rows, lists 2 levels deep, 256 KiB (v1 stays 64 KiB)', () => {
    const row = (n: number) => `<tr>${'<td>c</td>'.repeat(n)}</tr>`;
    expect(issueOf(`<table>${row(8)}</table>`)).toBeNull();
    expect(issueOf(`<table>${row(9)}</table>`)).toBe('table_too_large');
    expect(issueOf(`<table>${row(1).repeat(200)}</table>`)).toBeNull();
    expect(issueOf(`<table>${row(1).repeat(201)}</table>`)).toBe('table_too_large');
    expect(issueOf('<ul><li>a<ul><li>b</li></ul></li></ul>')).toBeNull();
    expect(issueOf('<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>')).toBe('list_too_deep');
    expect(issueOf('<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>', RTR_HTML_SCHEMA_V1)).toBeNull();
    const big = `<p>${'x'.repeat(100 * 1024)}</p>`;
    expect(issueOf(big)).toBeNull();
    expect(issueOf(big, RTR_HTML_SCHEMA_V1)).toBe('content_too_large');
    expect(issueOf(`<p>${'x'.repeat(257 * 1024)}</p>`)).toBe('content_too_large');
  });

  it('toRichBlocks: heading levels (h2 has none), tables with a header row, rule and page break', () => {
    const r = clean('<h2>A</h2><h3>B</h3><h4>C</h4><table><tr><th>H</th></tr><tr><td>v</td></tr></table><table><tr><td>no header</td></tr></table><hr><hr data-break="page">');
    const blocks = toRichBlocks(r.nodes, () => '');
    expect(blocks.map((b) => (b.kind === 'heading' ? `h${b.level ?? 2}` : b.kind === 'table' ? `table:${b.header}` : b.kind))).toEqual([
      'h2',
      'h3',
      'h4',
      'table:true',
      'table:false',
      'rule',
      'page_break',
    ]);
    expect(blocks[0]).not.toHaveProperty('level');
  });

  it('parseHtmlContent keeps the stored version', () => {
    expect(parseHtmlContent({ render_schema_version: RTR_HTML_SCHEMA_V2, title: 'T', html: '' })?.render_schema_version).toBe(RTR_HTML_SCHEMA_V2);
    expect(parseHtmlContent({ render_schema_version: 'rtr-html-v9', title: 'T', html: '' })).toBeNull();
  });
});

describe('C-16 / C-17 helpers — typed placeholders', () => {
  it('a known typed key becomes a chip; an unknown one stays text and is reported', () => {
    const r = clean('<p>Hi {{organization.name}} from {{hr_contact}}.</p>');
    const chipped = chipKnownTypedTokens(r.nodes, (k) => k === 'organization.name');
    expect(serialize(chipped)).toBe('<p>Hi <span data-field="organization.name"></span> from {{hr_contact}}.</p>');
    expect(typedPlaceholderKeys(chipped)).toEqual(['hr_contact']);
  });
});

describe('RtrTemplateCapabilities — v2 write and publish rules', () => {
  const caps = new RtrTemplateCapabilities(fakeCatalog());
  const draft = (html: string, version = RTR_HTML_SCHEMA_V2, existing: unknown = null) =>
    caps.normalizeDraftContent({
      document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
      render_schema_version: version,
      field_schema: { render_schema_version: version, title: 'Handbook', html },
      existing_field_schema: existing,
      requestId: 'r',
    });
  const reason = (p: Promise<unknown>) => p.then(() => null, (e: { context?: { details?: { reason?: string } } }) => e.context?.details?.reason ?? 'no-reason');

  it('C-4 / C-5 — v2 content is sanitised and kept as v2; an unknown version is refused', async () => {
    expect(await draft('<h3 class="x">Sub</h3><table><tr><td>a</td></tr></table>')).toMatchObject({
      render_schema_version: RTR_HTML_SCHEMA_V2,
      html: '<h3>Sub</h3><table><tr><td>a</td></tr></table>',
    });
    expect(await reason(draft('<p>x</p>', 'rtr-html-v9'))).toBe('unsupported_content_version');
  });

  it('C-6 — v2 content is never replaced by v1 (an outdated Studio); v1 over v1 is fine', async () => {
    const v2 = { render_schema_version: RTR_HTML_SCHEMA_V2, title: 'T', html: '<table><tr><td>x</td></tr></table>' };
    expect(await reason(draft('<p>x</p>', RTR_HTML_SCHEMA_V1, v2))).toBe('content_version_downgrade');
    expect(await reason(draft('<p>x</p>', RTR_HTML_SCHEMA_V1, { render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T', html: '' }))).toBeNull();
    expect(await reason(draft('<p>x</p>', RTR_HTML_SCHEMA_V2, { render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T', html: '' }))).toBeNull();
  });

  it('C-16 — a typed known variable becomes a chip on save; an unknown one stays text', async () => {
    const out = (await draft('<p>{{talent.full_name}} and {{hr_contact}}</p>')) as { html: string };
    expect(out.html).toBe('<p><span data-field="talent.full_name"></span> and {{hr_contact}}</p>');
  });

  it('C-17 — publish / activate refuses typed placeholders left in the body or unknown in the title; preview does not', async () => {
    const fs = { render_schema_version: RTR_HTML_SCHEMA_V2, title: 'Handbook', html: '<p>Contact {{hr_contact}}</p>' };
    const validate = (field_schema: unknown, unmodified_adopted_copy?: boolean) =>
      caps.validateDraftContent({ document_type_id: RIGHT_TO_REPRESENT_TYPE_ID, field_schema, render_schema_version: RTR_HTML_SCHEMA_V2, requestId: 'r', ...(unmodified_adopted_copy !== undefined ? { unmodified_adopted_copy } : {}) });
    await expect(validate(fs)).rejects.toThrow(expect.objectContaining({ context: expect.objectContaining({ details: { reason: 'unresolved_placeholder', keys: ['hr_contact'] } }) }));
    await expect(validate({ ...fs, html: '<p>Fine</p>', title: 'For {{nobody.here}}' })).rejects.toThrow(
      expect.objectContaining({ context: expect.objectContaining({ details: { reason: 'unresolved_placeholder', keys: ['nobody.here'] } }) }),
    );
    // A known key in the title is bound at render, so it is fine.
    await expect(validate({ ...fs, html: '<p>Fine</p>', title: 'For {{talent.full_name}}' })).resolves.toBeUndefined();
    // An unmodified adopted copy is exempt ("Use as it is" never breaks).
    await expect(validate(fs, true)).resolves.toBeUndefined();
    // Preview is never blocked by it.
    await expect(
      caps.renderSamplePreview({ document_type_id: RIGHT_TO_REPRESENT_TYPE_ID, field_schema: fs, render_schema_version: RTR_HTML_SCHEMA_V2, requestId: 'r' }),
    ).resolves.toMatchObject({ html: '<p>Contact {{hr_contact}}</p>' });
  });
});
