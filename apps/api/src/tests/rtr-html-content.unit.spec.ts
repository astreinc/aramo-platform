import { describe, expect, it } from 'vitest';

import {
  RTR_HTML_MAX_BYTES,
  RTR_HTML_SCHEMA_V1,
  convertV1ToHtml,
  sanitizeRtrHtml,
  toRichBlocks,
} from '../rtr/rtr-html-content.js';
import { RtrTemplateCapabilities } from '../rtr/rtr-template-capabilities.service.js';
import { RIGHT_TO_REPRESENT_TYPE_ID } from '../rtr/rtr-constants.js';
import { DEFAULT_RTR_TEMPLATE_CONTENT_V1, RTR_GENERATED_SCHEMA_V1 } from '../rtr/rtr-template-content.js';

// DOC-TEMPLATE-ADMIN-RTR-1 Amendment A1 — the rtr-html-v1 content contract: the
// authoritative allowlist sanitiser (A1 §2.2), v1 → html draft conversion (§2.1), the
// rich render model, and the capability's PATCH normalisation / preview / logo handling.

function clean(html: string): string {
  const r = sanitizeRtrHtml(html);
  if ('issue' in r) throw new Error(`unexpected issue ${r.issue.reason}`);
  return r.html;
}
function issue(html: string): { reason: string; keys?: string[] } {
  const r = sanitizeRtrHtml(html);
  if (!('issue' in r)) throw new Error(`expected an issue, got ${r.html}`);
  return r.issue;
}

describe('A1 §2.2 — allowlist sanitiser', () => {
  it('keeps exactly the allowlist (p, h2, b/strong, i/em, u, ul, ol, li, br) and normalises strong/em', () => {
    expect(clean('<h2>Scope</h2><p>A <strong>b</strong> <em>i</em> <u>u</u><br>next</p><ul><li>x</li></ul><ol><li>y</li></ol>')).toBe(
      '<h2>Scope</h2><p>A <b>b</b> <i>i</i> <u>u</u><br>next</p><ul><li>x</li></ul><ol><li>y</li></ol>',
    );
  });

  it('strips script/style (with content), event handlers, href/src/class/style attributes and unknown tags', () => {
    expect(clean('<p onclick="x()" class="c" style="color:red">Hi<script>alert(1)</script><style>p{}</style></p>')).toBe('<p>Hi</p>');
    expect(clean('<p><a href="https://evil.example">link</a> <img src="x" onerror="y"> <font color="red">t</font></p>')).toBe('<p>link  t</p>');
    expect(clean('<table><tr><td>cell</td></tr></table><iframe src="x">f</iframe>')).toBe('cell');
    expect(clean('<p>javascript:alert(1)</p>')).toBe('<p>javascript:alert(1)</p>'); // inert text, no URL attribute anywhere
  });

  it('field nodes: only data-field survives, the span is emptied; spans without data-field are unwrapped', () => {
    expect(clean('<p>Dear <span data-field="talent.full_name" class="chip" title="x">[Talent]</span>, <span>plain</span></p>')).toBe(
      '<p>Dear <span data-field="talent.full_name"></span>, plain</p>',
    );
  });

  it('an unknown data-field key → unknown_field with the offending keys (agreed pay stays excluded)', () => {
    expect(issue('<p><span data-field="agreed_pay_rate.amount"></span><span data-field="nope.x"></span></p>')).toEqual({
      reason: 'unknown_field',
      keys: ['agreed_pay_rate.amount', 'nope.x'],
    });
  });

  it('nested lists are preserved', () => {
    expect(clean('<ul><li>a<ul><li>a.1</li></ul></li><li>b</li></ul>')).toBe('<ul><li>a<ul><li>a.1</li></ul></li><li>b</li></ul>');
  });

  it('logo node: at most one, only as the FIRST child; other data-asset values refused', () => {
    expect(clean('<div data-asset="tenant.logo" class="x">ignored</div><p>Body</p>')).toBe('<div data-asset="tenant.logo"></div><p>Body</p>');
    expect(issue('<p>Body</p><div data-asset="tenant.logo"></div>').reason).toBe('logo_position');
    expect(issue('<div data-asset="tenant.logo"></div><div data-asset="tenant.logo"></div>').reason).toBe('logo_position');
    expect(issue('<div data-asset="client.logo"></div><p>x</p>')).toEqual({ reason: 'unknown_asset', keys: ['client.logo'] });
    expect(clean('<div><p>plain div is unwrapped</p></div>')).toBe('<p>plain div is unwrapped</p>');
  });

  it('64 KB limit (input and stored form)', () => {
    expect(issue(`<p>${'x'.repeat(RTR_HTML_MAX_BYTES)}</p>`).reason).toBe('content_too_large');
    expect(() => clean(`<p>${'x'.repeat(60 * 1024)}</p>`)).not.toThrow();
  });

  it('escapes text so the stored form is inert and idempotent', () => {
    const once = clean('<p>5 &lt; 6 &amp; "q"</p>');
    expect(once).toBe('<p>5 &lt; 6 &amp; &quot;q&quot;</p>');
    expect(clean(once)).toBe(once);
  });
});

describe('A1 §2.1 — rtr-generated-v1 → rtr-html-v1 draft conversion', () => {
  it('HEADING→h2, TEXT→p (escaped), {{token}}→field node, \\n→<br>', () => {
    const c = convertV1ToHtml({
      render_schema_version: RTR_GENERATED_SCHEMA_V1,
      title: 'Right to Represent',
      blocks: [
        { type: 'HEADING', text: 'Terms & <Scope>' },
        { type: 'TEXT', text: 'For {{talent.full_name}} at {{client.name}}.\nSecond line' },
      ],
    });
    expect(c).toEqual({
      render_schema_version: RTR_HTML_SCHEMA_V1,
      title: 'Right to Represent',
      html: '<h2>Terms &amp; &lt;Scope&gt;</h2><p>For <span data-field="talent.full_name"></span> at <span data-field="client.name"></span>.<br>Second line</p>',
      logo: null,
    });
    expect(clean(c.html)).toBe(c.html); // conversion output is already canonical
  });
});

describe('A1 §2.3 — rich render model', () => {
  it('runs carry marks; bound values are plain text inside the run; lists nest; br is a line break', () => {
    const r = sanitizeRtrHtml('<h2>T</h2><p>Hi <b><span data-field="talent.full_name"></span></b><br><i>x</i></p><ol><li>one<ul><li>sub</li></ul></li></ol>');
    if ('issue' in r) throw new Error('issue');
    const blocks = toRichBlocks(r.nodes, (k) => (k === 'talent.full_name' ? '<Ravi> & co' : '?'));
    expect(blocks[0]).toEqual({ kind: 'heading', runs: [{ text: 'T', bold: false, italic: false, underline: false }] });
    expect(blocks[1]).toEqual({
      kind: 'paragraph',
      runs: [
        { text: 'Hi ', bold: false, italic: false, underline: false },
        { text: '<Ravi> & co', bold: true, italic: false, underline: false },
        { text: '\n', bold: false, italic: false, underline: false },
        { text: 'x', bold: false, italic: true, underline: false },
      ],
    });
    expect(blocks[2]).toMatchObject({ kind: 'list', ordered: true, items: [{ runs: [{ text: 'one' }], children: [{ kind: 'list', ordered: false }] }] });
  });
});

describe('RtrTemplateCapabilities — rtr-html-v1', () => {
  const caps = new RtrTemplateCapabilities();
  const LOGO = { asset_id: 'a-1', sha256: 'f'.repeat(64), mime: 'image/png' as const };

  it('normalizeDraftContent sanitises html and carries the SERVER-OWNED logo from existing content (client value ignored)', () => {
    const out = caps.normalizeDraftContent({
      document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
      render_schema_version: RTR_HTML_SCHEMA_V1,
      field_schema: { render_schema_version: RTR_HTML_SCHEMA_V1, title: ' RTR ', html: '<p onclick="x">Hi</p>', logo: { asset_id: 'forged', sha256: 'x', mime: 'image/png' } },
      existing_field_schema: { render_schema_version: RTR_HTML_SCHEMA_V1, title: 'old', html: '', logo: LOGO },
      requestId: 'r',
    });
    expect(out).toEqual({ render_schema_version: RTR_HTML_SCHEMA_V1, title: 'RTR', html: '<p>Hi</p>', logo: LOGO });
  });

  it('normalizeDraftContent: unknown field → 422 VALIDATION_ERROR reason=unknown_field (+keys); logo misplaced → logo_position', () => {
    const run = (html: string) =>
      caps.normalizeDraftContent({
        document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
        render_schema_version: RTR_HTML_SCHEMA_V1,
        field_schema: { render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T', html },
        existing_field_schema: null,
        requestId: 'r',
      });
    expect(() => run('<p><span data-field="agreed_pay_rate.amount"></span></p>')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 422, context: expect.objectContaining({ details: { reason: 'unknown_field', keys: ['agreed_pay_rate.amount'] } }) }),
    );
    expect(() => run('<p>x</p><div data-asset="tenant.logo"></div>')).toThrow(
      expect.objectContaining({ statusCode: 422, context: expect.objectContaining({ details: { reason: 'logo_position' } }) }),
    );
  });

  it('normalizeDraftContent leaves rtr-generated-v1 content untouched (v1 drafts stay v1)', () => {
    expect(
      caps.normalizeDraftContent({
        document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
        render_schema_version: RTR_GENERATED_SCHEMA_V1,
        field_schema: DEFAULT_RTR_TEMPLATE_CONTENT_V1,
        existing_field_schema: null,
        requestId: 'r',
      }),
    ).toBe(DEFAULT_RTR_TEMPLATE_CONTENT_V1);
  });

  it('draftContentFrom converts a v1 ACTIVE to rtr-html-v1 and copies html content (logo reference included)', () => {
    const fromV1 = caps.draftContentFrom({ document_type_id: RIGHT_TO_REPRESENT_TYPE_ID, render_schema_version: RTR_GENERATED_SCHEMA_V1, field_schema: DEFAULT_RTR_TEMPLATE_CONTENT_V1 });
    expect(fromV1.render_schema_version).toBe(RTR_HTML_SCHEMA_V1);
    expect((fromV1.field_schema as { html: string }).html).toBe(
      '<h2>Right to Represent</h2><p>This authorizes representation of <span data-field="talent.full_name"></span> to the associated client for the associated requisition.</p>',
    );
    const html = { render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T', html: '<div data-asset="tenant.logo"></div><p>x</p>', logo: LOGO };
    expect(caps.draftContentFrom({ document_type_id: RIGHT_TO_REPRESENT_TYPE_ID, render_schema_version: RTR_HTML_SCHEMA_V1, field_schema: html })).toEqual({
      render_schema_version: RTR_HTML_SCHEMA_V1,
      field_schema: html,
    });
  });

  it('preview (html): sample_values for every binding, html with data-sample spans (escaped), logo ref, signature block', () => {
    const p = caps.renderSamplePreview({
      document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
      render_schema_version: RTR_HTML_SCHEMA_V1,
      field_schema: {
        render_schema_version: RTR_HTML_SCHEMA_V1,
        title: 'RTR',
        html: '<div data-asset="tenant.logo"></div><p><b><span data-field="talent.full_name"></span></b> at <span data-field="talent.desired_pay_rate"></span></p>',
        logo: LOGO,
      },
      requestId: 'r',
    });
    expect(p.html).toBe('<div data-asset="tenant.logo"></div><p><b><span data-sample="talent.full_name">Ravi Shankar</span></b> at <span data-sample="talent.desired_pay_rate">$70/hr</span></p>');
    expect(p.logo).toEqual({ asset_id: 'a-1' });
    expect(p.signature_block).toEqual({ printed_name: 'Ravi Shankar' });
    expect(p.blocks).toEqual([]);
    expect(p.sample_values?.map((s) => s.value)).toEqual([
      'Ravi Shankar',
      '$70/hr',
      'Mindlance',
      'Business Analyst - Multi-Family',
      'REQ-1001',
      'Analyze business requirements for multi-family housing programs.\n\nPartner with stakeholders to define scope and acceptance criteria.',
      'Astre Consulting',
      'Deepika Rao',
    ]);
    expect(p.sample_values?.find((s) => s.key === 'recruiting_company.name')?.label).toBe('Recruiting company');
  });

  it('preview (v1) also carries sample_values', () => {
    const p = caps.renderSamplePreview({ document_type_id: RIGHT_TO_REPRESENT_TYPE_ID, render_schema_version: RTR_GENERATED_SCHEMA_V1, field_schema: DEFAULT_RTR_TEMPLATE_CONTENT_V1, requestId: 'r' });
    expect(p.sample_values).toHaveLength(8);
    expect(p.html).toBeUndefined();
  });

  it('activation validation: a logo node without a captured logo (or vice versa) fails closed; unknown version fails closed', () => {
    const v = (field_schema: unknown, render_schema_version = RTR_HTML_SCHEMA_V1) => () =>
      caps.validateDraftContent({ document_type_id: RIGHT_TO_REPRESENT_TYPE_ID, field_schema, render_schema_version, requestId: 'r' });
    expect(v({ render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T', html: '<div data-asset="tenant.logo"></div><p>x</p>' })).toThrow(
      expect.objectContaining({ context: expect.objectContaining({ details: { reason: 'logo_asset_mismatch' } }) }),
    );
    expect(v({ render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T', html: '<p>x</p>', logo: LOGO })).toThrow(
      expect.objectContaining({ context: expect.objectContaining({ details: { reason: 'logo_asset_mismatch' } }) }),
    );
    expect(v({ render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T', html: '<p> </p>' })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(v({}, 'rtr-html-v2')).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(v({ render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T', html: '<p>ok <span data-field="client.name"></span></p>' })).not.toThrow();
  });

  it('withLogo attaches (logo node becomes the first child) and detaches (reference + node removed)', () => {
    const base = { render_schema_version: RTR_HTML_SCHEMA_V1, title: 'T', html: '<p>Body</p>', logo: null };
    const on = caps.withLogo(base, LOGO, 'r') as { html: string; logo: unknown };
    expect(on).toMatchObject({ html: '<div data-asset="tenant.logo"></div><p>Body</p>', logo: LOGO });
    expect(caps.logoOf(on)).toEqual(LOGO);
    const off = caps.withLogo(on, null, 'r') as { html: string; logo: unknown };
    expect(off).toMatchObject({ html: '<p>Body</p>', logo: null });
    expect(() => caps.withLogo(DEFAULT_RTR_TEMPLATE_CONTENT_V1, LOGO, 'r')).toThrow(
      expect.objectContaining({ context: expect.objectContaining({ details: { reason: 'logo_requires_html_content' } }) }),
    );
  });
});
