import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type {
  TemplateBindingDescriptor,
  TemplateCapabilitiesPort,
  TemplateLogoRef,
  TemplateSamplePreview,
} from '@aramo/documents';

import {
  RTR_BINDING_CATALOG,
  RTR_BINDING_SAMPLE_VALUES,
  RTR_GENERATED_SCHEMA_V1,
  isRtrBindingKey,
  type RtrBindingKey,
  type RtrContentBlock,
  type RtrTemplateContentV1,
} from './rtr-template-content.js';
import {
  RTR_HTML_SCHEMA_V1,
  TENANT_LOGO_ASSET,
  convertV1ToHtml,
  hasLogoNode,
  htmlWithSamples,
  parseHtmlContent,
  parseLogoRef,
  sanitizeRtrHtml,
  serialize,
  type HtmlNode,
  type RtrTemplateContentHtmlV1,
} from './rtr-html-content.js';
import { RIGHT_TO_REPRESENT_TYPE_ID } from './rtr-constants.js';

// DOC-TEMPLATE-ADMIN-RTR-1 — the RTR implementation of the generic template-content
// capability port (§14/§15/§17), extended by Amendment A1 for `rtr-html-v1`. PURE: the
// closed RTR binding catalog + fixed sample values + the allowlist sanitiser; no
// repositories, no renderer, no storage — admin preview uses SAMPLE data and never
// touches authoritative facts or creates a business Document. RTR is the only
// configurable document type; every other type is a no-op / empty.
//
// Recognised content versions: EXACTLY 'rtr-generated-v1' and 'rtr-html-v1' (A1 §2.1).
// Anything else fails closed.

const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

function htmlInvalid(requestId: string, reason: string, keys?: string[]): AramoError {
  return new AramoError('VALIDATION_ERROR', `RTR template content rejected: ${reason}`, 422, {
    requestId,
    details: { reason, ...(keys !== undefined ? { keys } : {}) },
  });
}

@Injectable()
export class RtrTemplateCapabilities implements TemplateCapabilitiesPort {
  isConfigurable(documentTypeId: string): boolean {
    return documentTypeId === RIGHT_TO_REPRESENT_TYPE_ID;
  }

  listAllowedBindings(documentTypeId: string): readonly TemplateBindingDescriptor[] {
    if (!this.isConfigurable(documentTypeId)) return [];
    return RTR_BINDING_CATALOG.map((d) => ({ key: d.key, label: d.label, group: d.group }));
  }

  validateDraftContent(input: { document_type_id: string; field_schema: unknown; render_schema_version: string; requestId: string }): void {
    if (!this.isConfigurable(input.document_type_id)) return; // non-configurable → nothing to validate
    if (input.render_schema_version === RTR_HTML_SCHEMA_V1) {
      this.validateHtml(input);
      return;
    }
    const content = this.parse(input);
    if (content.title.trim() === '' || content.blocks.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'template content must have a title and at least one block', 400, { requestId: input.requestId });
    }
    for (const key of this.collectTokens(content)) {
      if (!isRtrBindingKey(key)) {
        throw new AramoError('TEMPLATE_BINDING_UNSUPPORTED', `template content references an unsupported binding: {{${key}}}`, 422, { requestId: input.requestId, details: { binding_key: key } });
      }
    }
  }

  renderSamplePreview(input: { document_type_id: string; field_schema: unknown; render_schema_version: string; requestId: string }): TemplateSamplePreview {
    this.validateDraftContent(input); // validate structure + bindings first (fail closed)
    const sub = (text: string): string =>
      text.replace(TOKEN_RE, (_whole, key: string) => (isRtrBindingKey(key) ? RTR_BINDING_SAMPLE_VALUES[key as RtrBindingKey] : `{{${key}}}`));
    const sample_values = RTR_BINDING_CATALOG.map((d) => ({ key: d.key, label: d.label, value: d.sample }));
    const signature_block = { printed_name: RTR_BINDING_SAMPLE_VALUES['talent.full_name'] };
    if (input.render_schema_version === RTR_HTML_SCHEMA_V1) {
      const { content, nodes } = this.validateHtml(input);
      return {
        title: sub(content.title),
        blocks: [],
        html: htmlWithSamples(nodes, (key) => RTR_BINDING_SAMPLE_VALUES[key as RtrBindingKey]),
        logo: content.logo ? { asset_id: content.logo.asset_id } : null,
        sample_values,
        signature_block,
      };
    }
    const content = this.parse(input);
    return {
      title: sub(content.title),
      blocks: content.blocks.map((b) => ({ type: b.type, text: sub(b.text) })),
      // B2 — the fixed signature block (PRINTED NAME = the talent.full_name sample).
      signature_block,
      sample_values,
    };
  }

  // A1 §2.2 — PATCH-time authoritative sanitisation (rtr-html-v1 only).
  normalizeDraftContent(input: {
    document_type_id: string;
    render_schema_version: string;
    field_schema: unknown;
    existing_field_schema: unknown;
    requestId: string;
  }): unknown {
    if (!this.isConfigurable(input.document_type_id) || input.render_schema_version !== RTR_HTML_SCHEMA_V1) return input.field_schema;
    const fs = input.field_schema;
    if (fs === null || typeof fs !== 'object' || Array.isArray(fs)) throw htmlInvalid(input.requestId, 'content_invalid');
    const o = fs as Record<string, unknown>;
    if (typeof o.title !== 'string' || typeof o.html !== 'string') throw htmlInvalid(input.requestId, 'content_invalid');
    const res = sanitizeRtrHtml(o.html);
    if ('issue' in res) throw htmlInvalid(input.requestId, res.issue.reason, res.issue.keys);
    // The logo reference is SERVER-OWNED: carried over from the existing content only.
    const existingLogo = parseLogoRef((input.existing_field_schema as Record<string, unknown> | null)?.['logo']);
    const content: RtrTemplateContentHtmlV1 = {
      render_schema_version: RTR_HTML_SCHEMA_V1,
      title: o.title.trim(),
      html: res.html,
      logo: existingLogo,
    };
    return content;
  }

  draftContentFrom(input: { document_type_id: string; render_schema_version: string; field_schema: unknown }): { render_schema_version: string; field_schema: unknown } {
    if (!this.isConfigurable(input.document_type_id)) return { render_schema_version: input.render_schema_version, field_schema: input.field_schema };
    if (input.render_schema_version === RTR_GENERATED_SCHEMA_V1) {
      const v1 = this.tryParseV1(input.field_schema);
      if (v1 !== null) return { render_schema_version: RTR_HTML_SCHEMA_V1, field_schema: convertV1ToHtml(v1) };
    }
    return { render_schema_version: input.render_schema_version, field_schema: input.field_schema };
  }

  logoOf(field_schema: unknown): TemplateLogoRef | null {
    const c = parseHtmlContent(field_schema);
    return c?.logo ?? null;
  }

  withLogo(field_schema: unknown, logo: TemplateLogoRef | null, requestId: string): unknown {
    const c = parseHtmlContent(field_schema);
    if (c === null) throw htmlInvalid(requestId, 'logo_requires_html_content');
    const res = sanitizeRtrHtml(c.html);
    if ('issue' in res) throw htmlInvalid(requestId, res.issue.reason, res.issue.keys);
    const nodes: HtmlNode[] = res.nodes;
    const withoutLogo = nodes.filter((n) => !(n.type === 'el' && n.tag === 'div' && n.attrs['data-asset'] !== undefined));
    const next: HtmlNode[] =
      logo === null
        ? withoutLogo
        : hasLogoNode(nodes)
          ? nodes
          : [{ type: 'el', tag: 'div', attrs: { 'data-asset': TENANT_LOGO_ASSET }, children: [] }, ...withoutLogo];
    return { ...c, html: serialize(next), logo };
  }

  // rtr-html-v1 structural + allowlist validation (activation / preview). The stored html
  // was sanitised at PATCH; re-checking here keeps activation authoritative.
  private validateHtml(input: { field_schema: unknown; requestId: string }): { content: RtrTemplateContentHtmlV1; nodes: HtmlNode[] } {
    const content = parseHtmlContent(input.field_schema);
    if (content === null) throw new AramoError('VALIDATION_ERROR', 'RTR html content is empty or invalid', 400, { requestId: input.requestId });
    const res = sanitizeRtrHtml(content.html);
    if ('issue' in res) {
      if (res.issue.reason === 'unknown_field') {
        throw new AramoError('TEMPLATE_BINDING_UNSUPPORTED', `template content references an unsupported binding: ${(res.issue.keys ?? []).join(', ')}`, 422, {
          requestId: input.requestId,
          details: { reason: 'unknown_field', keys: res.issue.keys },
        });
      }
      throw htmlInvalid(input.requestId, res.issue.reason, res.issue.keys);
    }
    const hasText = res.nodes.some(function nonEmpty(n): boolean {
      if (n.type === 'text') return n.text.trim().length > 0;
      if (n.tag === 'span' && n.attrs['data-field'] !== undefined) return true;
      return n.children.some(nonEmpty);
    });
    if (content.title.trim() === '' || !hasText) {
      throw new AramoError('VALIDATION_ERROR', 'template content must have a title and some content', 400, { requestId: input.requestId });
    }
    // A logo node needs a captured logo asset (and vice versa) — fail closed.
    if (hasLogoNode(res.nodes) !== (content.logo !== null && content.logo !== undefined)) {
      throw htmlInvalid(input.requestId, 'logo_asset_mismatch');
    }
    return { content, nodes: res.nodes };
  }

  private tryParseV1(fs: unknown): RtrTemplateContentV1 | null {
    try {
      return this.parse({ field_schema: fs, render_schema_version: RTR_GENERATED_SCHEMA_V1, requestId: 'draft-conversion' });
    } catch {
      return null;
    }
  }

  // Parse + structurally validate the stored field_schema as RTR content V1.
  private parse(input: { field_schema: unknown; render_schema_version: string; requestId: string }): RtrTemplateContentV1 {
    if (input.render_schema_version !== RTR_GENERATED_SCHEMA_V1) {
      throw new AramoError('VALIDATION_ERROR', `unsupported RTR content version: ${input.render_schema_version}`, 400, { requestId: input.requestId });
    }
    const fs = input.field_schema;
    if (fs === null || typeof fs !== 'object' || Array.isArray(fs)) {
      throw new AramoError('VALIDATION_ERROR', 'RTR content is empty or invalid', 400, { requestId: input.requestId });
    }
    const obj = fs as Record<string, unknown>;
    if (typeof obj.title !== 'string' || !Array.isArray(obj.blocks)) {
      throw new AramoError('VALIDATION_ERROR', 'RTR content must have a string title and a blocks array', 400, { requestId: input.requestId });
    }
    const blocks: RtrContentBlock[] = obj.blocks.map((b) => {
      const bb = b as Record<string, unknown>;
      if ((bb.type !== 'HEADING' && bb.type !== 'TEXT') || typeof bb.text !== 'string') {
        throw new AramoError('VALIDATION_ERROR', 'invalid RTR content block (type must be HEADING|TEXT, text a string)', 400, { requestId: input.requestId });
      }
      return { type: bb.type, text: bb.text };
    });
    return { render_schema_version: RTR_GENERATED_SCHEMA_V1, title: obj.title, blocks };
  }

  private collectTokens(content: RtrTemplateContentV1): Set<string> {
    const out = new Set<string>();
    for (const text of [content.title, ...content.blocks.map((b) => b.text)]) {
      for (const m of text.matchAll(TOKEN_RE)) {
        if (m[1] !== undefined) out.add(m[1]);
      }
    }
    return out;
  }
}
