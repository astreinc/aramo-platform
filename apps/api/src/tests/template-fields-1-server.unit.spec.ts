import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { AramoError } from '@aramo/common';
import { PdfLibDocumentRenderingAdapter, type RichBlock } from '@aramo/documents-rendering';
import { parseInlineFieldRows, type InlineFieldRowInput } from '@aramo/documents';
import { RTR_HTML_V2, RTR_HTML_V3 } from '@aramo/template-content';

import { SignTemplateLibraryService, inlinePlacements } from '../documents/sign-template-library.service.js';
import { RIGHT_TO_REPRESENT_TYPE_ID } from '../rtr/rtr-constants.js';
import { collectFieldKeys, collectInlineFieldMarkers, htmlWithSamples, parseHtmlContent, sanitizeRtrHtml, type RtrTemplateContentHtmlV1 } from '../rtr/rtr-html-content.js';
import { RtrTemplateBindingService } from '../rtr/rtr-template-binding.service.js';
import { RtrTemplateCapabilities } from '../rtr/rtr-template-capabilities.service.js';

import { fakeCatalog } from './fixtures/rtr-seed-catalog.js';

// TEMPLATE-FIELDS-1 (Aramo-Template-Fields-1-Directive-v1_0-LOCKED) §5.1 / §5.3 — the server rules
// for fields placed inside editable content: the sanitiser (F-2), markers ↔ rows (F-3), roles
// (F-6), fit (F-9), the tenant lock (F-15), ATS (F-17), the preview (F-13), the Sign binding
// (F-6 blocks, F-8 sizes), "Use" positions (F-10) and field_not_placed.

const known = () => true;
const sanitize = (html: string, version: string = RTR_HTML_V3) => sanitizeRtrHtml(html, known, version as typeof RTR_HTML_V3);
const reasonOf = (html: string) => {
  const r = sanitize(html);
  return 'issue' in r ? r.issue.reason : null;
};

const SIGNING = {
  roles: [
    { role_key: 'employee', label: 'Employee', kind: 'SIGNER', order: 1 },
    { role_key: 'manager', label: 'Manager', kind: 'SIGNER', order: 2 },
  ],
  routing_mode: 'PARALLEL',
};

function rows(raw: unknown[]): InlineFieldRowInput[] {
  const p = parseInlineFieldRows(raw, { sender_filled_enabled: true });
  if (!p.ok) throw new Error(`fixture rows: ${p.reason}`);
  return p.rows;
}
const SIG = { field_key: 'employee_signature', field_type: 'SIGNATURE', signer_role: 'employee', required: true };
const INI = { field_key: 'employee_initials', field_type: 'INITIALS', signer_role: 'employee', required: true };
const ACK = { field_key: 'policy_ack', field_type: 'CHECKBOX', signer_role: 'employee' };
const HANDBOOK_HTML =
  '<h2>Acknowledgement</h2><p>I have read the handbook. Initials: <span data-sign-field="employee_initials"></span></p>' +
  '<ul><li>I accept the IT policy <span data-sign-field="policy_ack"></span></li></ul>' +
  '<p>Signed: <span data-sign-field="employee_signature"></span></p>';

async function reasonOfCall(p: Promise<unknown>): Promise<{ reason: unknown; details: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AramoError);
    const details = ((e as AramoError).context.details ?? {}) as Record<string, unknown>;
    return { reason: details['reason'], details };
  }
  throw new Error('expected a refusal');
}

describe('F-2 — the server sanitiser keeps the marker only where allowed', () => {
  const fixtures = JSON.parse(readFileSync(resolve(__dirname, '../../../../libs/template-content/test-fixtures/inline-fields.json'), 'utf8')) as {
    cases: { name: string; input: string; canonical: string; markers: string[] }[];
  };
  for (const c of fixtures.cases) {
    it(`shared fixture: ${c.name}`, () => {
      const r = sanitize(c.input);
      if ('issue' in r) throw new Error(r.issue.reason);
      expect(r.html).toBe(c.canonical);
      expect(collectInlineFieldMarkers(r.nodes).map((m) => m.key)).toEqual(c.markers);
    });
  }

  it('v1 / v2 read exactly as before: the marker is discarded', () => {
    const r = sanitizeRtrHtml('<p>Signed: <span data-sign-field="sig"></span></p>', known, RTR_HTML_V2);
    expect('html' in r && r.html).toBe('<p>Signed: </p>');
  });

  it('never in a heading, nor loose outside a block: field_position_not_allowed', () => {
    expect(reasonOf('<h2>Title <span data-sign-field="sig"></span></h2>')).toBe('field_position_not_allowed');
    expect(reasonOf('<h3><span data-sign-field="sig"></span></h3>')).toBe('field_position_not_allowed');
    expect(reasonOf('loose <span data-sign-field="sig"></span>')).toBe('field_position_not_allowed');
  });

  it('a repeated marker is refused (field_marker_duplicate); a bad key (field_marker_mismatch)', () => {
    expect(reasonOf('<p><span data-sign-field="sig"></span><span data-sign-field="sig"></span></p>')).toBe('field_marker_duplicate');
    expect(reasonOf('<p><span data-sign-field="Bad-Key"></span></p>')).toBe('field_marker_mismatch');
  });

  it('a marker is never a variable', () => {
    const r = sanitize('<p><span data-sign-field="sig"></span></p>');
    expect('nodes' in r && collectFieldKeys(r.nodes)).toEqual([]);
  });

  it('places: paragraph, list item (by level), table cell (by columns)', () => {
    const r = sanitize('<p><span data-sign-field="a"></span></p><ul><li>x<ul><li><span data-sign-field="b"></span></li></ul></li></ul><table><tr><td>1</td><td>2</td><td><span data-sign-field="c"></span></td></tr></table>');
    expect('nodes' in r && collectInlineFieldMarkers(r.nodes).map((m) => m.place)).toEqual([
      { in: 'paragraph' },
      { in: 'list', level: 1 },
      { in: 'table', columns: 3 },
    ]);
  });
});

describe('F-3 / F-6 / F-9 / F-15 — draft writes (normalizeDraftContent)', () => {
  const caps = new RtrTemplateCapabilities(fakeCatalog());
  const write = (html: string, fields: InlineFieldRowInput[], opts: { signing?: unknown; owner?: 'PLATFORM' | 'TENANT' } = {}) =>
    caps.normalizeDraftContent({
      document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
      render_schema_version: RTR_HTML_V3,
      field_schema: { render_schema_version: RTR_HTML_V3, title: 'Handbook', html, ...(opts.signing !== undefined ? { signing: opts.signing } : { signing: SIGNING }) },
      existing_field_schema: null,
      requestId: 'r',
      fields,
      owner: opts.owner ?? 'PLATFORM',
    });

  it('content and rows that agree are saved (the markers kept)', async () => {
    const out = (await write(HANDBOOK_HTML, rows([SIG, INI, ACK]))) as { html: string };
    expect(out.html).toContain('<span data-sign-field="employee_signature"></span>');
  });

  it('a marker without its row and a row without its marker: field_marker_mismatch (missing / orphans)', async () => {
    const r = await reasonOfCall(write(HANDBOOK_HTML, rows([SIG, INI, { field_key: 'extra_text', field_type: 'TEXT', signer_role: 'employee' }])));
    expect(r.reason).toBe('field_marker_mismatch');
    expect(r.details['missing']).toEqual(['policy_ack']);
    expect(r.details['orphans']).toEqual(['extra_text']);
  });

  it('a key repeated among the rows: field_marker_duplicate', async () => {
    const r = await reasonOfCall(write(HANDBOOK_HTML, rows([SIG, INI, ACK, { ...ACK, field_type: 'TEXT' }])));
    expect(r.reason).toBe('field_marker_duplicate');
  });

  it('inline fields need signing roles; each field names a SIGNER role or is sender-filled', async () => {
    expect((await reasonOfCall(write(HANDBOOK_HTML, rows([SIG, INI, ACK]), { signing: null }))).reason).toBe('signing_roles_required');
    expect((await reasonOfCall(write(HANDBOOK_HTML, rows([SIG, INI, { ...ACK, signer_role: 'nobody' }])))).reason).toBe('signing_roles_required');
    expect((await reasonOfCall(write(HANDBOOK_HTML, rows([SIG, INI, { ...ACK, signer_role: null }])))).reason).toBe('signing_roles_required');
    // F-7 — sender-filled (its type takes sender_filled): no role needed.
    await expect(write(HANDBOOK_HTML, rows([SIG, INI, { ...ACK, signer_role: null, sender_filled: true }]))).resolves.toBeTruthy();
  });

  it('field_too_wide: a 230pt signature in an 8-column table cell is refused with the field and the place', async () => {
    const html = `<table><tr>${'<td>x</td>'.repeat(7)}<td><span data-sign-field="employee_signature"></span></td></tr></table>`;
    const r = await reasonOfCall(write(html, rows([SIG])));
    expect(r.reason).toBe('field_too_wide');
    expect(r.details).toMatchObject({ field_key: 'employee_signature', place: 'table_cell', width: 230, max_width: 55 });
    // The same field fits a 2-column cell.
    await expect(write('<table><tr><td>Employee</td><td><span data-sign-field="employee_signature"></span></td></tr></table>', rows([SIG]))).resolves.toBeTruthy();
  });

  it('F-15 — a tenant save that changes the field set is refused as fields_platform_only', async () => {
    const without = HANDBOOK_HTML.replace('<span data-sign-field="policy_ack"></span>', '');
    expect((await reasonOfCall(write(without, rows([SIG, INI, ACK]), { owner: 'TENANT' }))).reason).toBe('fields_platform_only');
    // Wording around the fields stays editable.
    await expect(write(HANDBOOK_HTML.replace('I have read', 'I confirm I have read'), rows([SIG, INI, ACK]), { owner: 'TENANT' })).resolves.toBeTruthy();
  });

  it('Word import / a new draft without rows cannot carry markers (field_marker_mismatch)', async () => {
    const r = await reasonOfCall(write(HANDBOOK_HTML, []));
    expect(r.reason).toBe('field_marker_mismatch');
  });
});

describe('F-17 / F-13 — publish and preview', () => {
  const caps = new RtrTemplateCapabilities(fakeCatalog());
  const fs = { render_schema_version: RTR_HTML_V3, title: 'Handbook', html: HANDBOOK_HTML, signing: SIGNING };

  it('an `ats` template cannot have inline fields (inline_fields_not_supported_for_ats); a `sign` one can', async () => {
    const base = { document_type_id: RIGHT_TO_REPRESENT_TYPE_ID, field_schema: fs, render_schema_version: RTR_HTML_V3, requestId: 'r', fields: rows([SIG, INI, ACK]) };
    expect((await reasonOfCall(caps.validateDraftContent({ ...base, products: ['ats', 'sign'] }))).reason).toBe('inline_fields_not_supported_for_ats');
    await expect(caps.validateDraftContent({ ...base, products: ['sign'] })).resolves.toBeUndefined();
    expect((await reasonOfCall(caps.validateDraftContent({ ...base, products: ['sign'], fields: rows([SIG, INI]) }))).reason).toBe('field_marker_mismatch');
  });

  it('the sample preview draws each inline field as a labelled box (type and role)', async () => {
    const out = await caps.renderSamplePreview({ document_type_id: RIGHT_TO_REPRESENT_TYPE_ID, field_schema: fs, render_schema_version: RTR_HTML_V3, requestId: 'r', fields: rows([SIG, INI, { ...ACK, label: 'IT policy' }]) });
    expect(out.html).toContain('<span data-sign-field-sample="employee_signature">Signature · Employee</span>');
    expect(out.html).toContain('<span data-sign-field-sample="policy_ack">IT policy · Employee</span>');
    expect(htmlWithSamples([], () => '')).toBe('');
  });
});

describe('F-6 / F-8 / F-10 — the Sign binding, render and "Use"', () => {
  const tenants = { findBrandingById: async () => null };
  const binding = new RtrTemplateBindingService({} as never, {} as never, {} as never, tenants as never, {} as never);
  const html = '<p>I, <span data-field="talent.full_name"></span>, accept. Signed: <span data-sign-field="employee_signature"></span></p><p>Manager initials <span data-sign-field="manager_initials"></span></p>';
  const content = parseHtmlContent({ render_schema_version: RTR_HTML_V3, title: 'Offer', html, signing: SIGNING }) as RtrTemplateContentHtmlV1;
  const fieldRows = rows([SIG, { field_key: 'manager_initials', field_type: 'INITIALS', signer_role: 'manager' }]);
  const bind = (name: string, inline = fieldRows) =>
    binding.bindProvided({ content, template_version_id: 'v', tenant_id: 't', values: new Map([['talent.full_name', name]]), requestId: 'r', inline_fields: inline });

  it('boxes carry the catalog sizes; a role with an inline SIGNATURE gets no appended block (R-4), the others keep theirs', async () => {
    const model = await bind('Ravi');
    const runs = (model.rich_blocks as RichBlock[]).flatMap((b) => (b.kind === 'paragraph' ? b.runs : []));
    expect(runs.filter((r) => 'kind' in r)).toEqual([
      { kind: 'field', field_key: 'employee_signature', width: 230, height: 50 },
      { kind: 'field', field_key: 'manager_initials', width: 60, height: 30 },
    ]);
    expect(model.signature_blocks).toEqual([{ role_key: 'manager', label: 'Manager' }]);
  });

  it('a marker without its row fails the render (field_not_placed), never dropped', async () => {
    expect((await reasonOfCall(bind('Ravi', fieldRows.slice(0, 1)))).reason).toBe('field_not_placed');
  });

  it('ATS binding refuses content with inline fields', async () => {
    const r = await reasonOfCall(binding.bind({ content, template_version_id: 'v', tenant_id: 't', talent_id: 'x', requisition_id: 'y', company_id: 'z', recruiter_user_id: 'u', requestId: 'r' }));
    expect(r.reason).toBe('inline_fields_not_supported_for_ats');
  });

  it('longer bound names move the boxes; the positions are recorded per render', async () => {
    const adapter = new PdfLibDocumentRenderingAdapter();
    const short = await adapter.renderGenerated(await bind('Al'));
    const long = await adapter.renderGenerated(await bind('Bartholomew Alexander Montgomery-Fitzwilliam the Third of Westmoreland'));
    const s = short.inline_fields!.find((f) => f.field_key === 'employee_signature')!;
    const l = long.inline_fields!.find((f) => f.field_key === 'employee_signature')!;
    expect(`${l.x},${l.y}`).not.toBe(`${s.x},${s.y}`);
    expect(short.inline_fields!.map((f) => f.field_key)).toEqual(['employee_signature', 'manager_initials']);
  });

  function library(manifest: unknown, defs: unknown[]) {
    const d = {
      documents: {
        getDocument: async () => ({ id: 'doc', title: 'Offer' }),
        getCurrentRevision: async () => ({ id: 'rev', content_sha256: 'h'.repeat(64), byte_size: 10, template_version_id: 'ver', render_manifest: manifest }),
      },
      templates: {
        findVersionByIdOwnerAware: async () => ({ id: 'ver', template_id: 'tpl', version_number: 3, render_schema_version: RTR_HTML_V3, field_schema: { render_schema_version: RTR_HTML_V3, title: 'Offer', html, signing: SIGNING } }),
        listFieldDefinitionsOwnerAware: async () => defs,
      },
    };
    return new SignTemplateLibraryService(d as never);
  }
  const def = (field_key: string, field_type: string, signer_role: string) => ({
    field_key,
    field_type,
    signer_role,
    required: true,
    page_number: null,
    x: null,
    y: null,
    width: null,
    height: null,
  });

  it('"Use" returns field_definitions with the render positions for a multi-role template', async () => {
    const manifest = {
      inline_fields: [
        { field_key: 'employee_signature', page_number: 0, x: 120.5, y: 600, width: 230, height: 50 },
        { field_key: 'manager_initials', page_number: 0, x: 160, y: 540, width: 60, height: 30 },
      ],
    };
    const svc = library(manifest, [def('employee_signature', 'SIGNATURE', 'employee'), def('manager_initials', 'INITIALS', 'manager')]);
    const out = (await (svc as unknown as { frozenResponse: (t: string, d: string, r: string) => Promise<Record<string, unknown>> }).frozenResponse('t', 'doc', 'r'))!;
    expect(out['field_definitions']).toMatchObject([
      { field_key: 'employee_signature', signer_role: 'employee', page_number: 0, x: 120.5, y: 600, width: 230, height: 50 },
      { field_key: 'manager_initials', signer_role: 'manager', page_number: 0, x: 160, y: 540, width: 60, height: 30 },
    ]);
    expect(out['inline_fields']).toEqual(manifest.inline_fields);
    expect(inlinePlacements(null).size).toBe(0);
  });

  it('a row the render did not place fails (field_not_placed)', async () => {
    const svc = library({ inline_fields: [{ field_key: 'employee_signature', page_number: 0, x: 1, y: 2, width: 230, height: 50 }] }, [
      def('employee_signature', 'SIGNATURE', 'employee'),
      def('manager_initials', 'INITIALS', 'manager'),
    ]);
    const r = await reasonOfCall((svc as unknown as { frozenResponse: (t: string, d: string, r: string) => Promise<unknown> }).frozenResponse('t', 'doc', 'r'));
    expect(r.reason).toBe('field_not_placed');
    expect(r.details['keys']).toEqual(['manager_initials']);
  });
});
