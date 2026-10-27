import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  TemplateVariablesRepository,
  type TemplateBindingDescriptor,
  type TemplateCapabilitiesPort,
  type TemplateLogoRef,
  type TemplateSamplePreview,
  type TemplateVariableCatalogReader,
  type TemplateVariableRow,
} from '@aramo/documents';

import {
  RTR_BINDING_KEYS,
  RTR_GENERATED_SCHEMA_V1,
  isRtrBindingKey,
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
  parseSigningConfig,
  sanitizeRtrHtml,
  serialize,
  type HtmlNode,
  type RtrTemplateContentHtmlV1,
} from './rtr-html-content.js';
import { RIGHT_TO_REPRESENT_TYPE_ID } from './rtr-constants.js';

// DOC-TEMPLATE-ADMIN-RTR-1 — the RTR implementation of the generic template-content
// capability port (§14/§15/§17), extended by Amendment A1 for `rtr-html-v1`. No
// renderer, no storage — admin preview uses SAMPLE data and never touches
// authoritative facts or creates a business Document. RTR is the only configurable
// document type; every other type is a no-op / empty.
//
// DOC-TEMPLATE-LIB-1 T-2 (§2 F-7; ADR-0034 D7; conforming amendment row 5) — the
// allowed bindings (keys, labels, groups, preview samples) are READ from the
// Aramo-maintained TemplateVariable catalog, not the code list. RTR is an ATS document
// type, so a catalog row is offered only when it is ACTIVE and carries an
// ats_binding_key. The binding VALUE resolvers stay in apps/api
// (rtr-template-binding.service), so the catalog is intersected with the resolver key
// set (RTR_BINDING_KEYS) — fail closed: a catalog key without a resolver is never
// offered and a template using one is rejected (TEMPLATE_BINDING_UNSUPPORTED,
// details.reason no_resolver). The binding service resolves by token key, so a row is
// resolvable only when ats_binding_key === key (aliasing is not supported yet).
// For the 8 seeded keys (A2 talent.desired_pay_rate included) behaviour is identical
// to the former code catalog: same keys, order, labels, groups and samples.
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

// One allowed binding resolved from the catalog (descriptor + safe preview sample).
interface CatalogBinding {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly sample: string;
  // TEMPLATE-STUDIO-1 B-2 — the catalog row's own metadata (descriptor only; the preview
  // keeps using `sample`, the safe '' fallback).
  readonly data_type: string;
  readonly sample_value: string | null;
  readonly active: boolean;
}

// The resolver order (RTR_BINDING_KEYS) is the menu order — identical to the former
// code catalog for the 8 seeded keys.
function resolverIndex(key: string): number {
  return (RTR_BINDING_KEYS as readonly string[]).indexOf(key);
}

// A catalog row is resolvable for an ATS document type iff it carries an
// ats_binding_key that names an apps/api resolver AND equals the token key (the
// binding service resolves by token key).
export function hasAtsResolver(row: Pick<TemplateVariableRow, 'key' | 'ats_binding_key'>): boolean {
  return row.ats_binding_key !== null && row.ats_binding_key === row.key && isRtrBindingKey(row.ats_binding_key);
}

function unsupportedBinding(requestId: string, key: string, reason?: 'no_resolver'): AramoError {
  return new AramoError('TEMPLATE_BINDING_UNSUPPORTED', `template content references an unsupported binding: {{${key}}}`, 422, {
    requestId,
    details: { binding_key: key, ...(reason !== undefined ? { reason } : {}) },
  });
}

@Injectable()
export class RtrTemplateCapabilities implements TemplateCapabilitiesPort {
  constructor(@Inject(TemplateVariablesRepository) private readonly catalog: TemplateVariableCatalogReader) {}

  isConfigurable(documentTypeId: string): boolean {
    return documentTypeId === RIGHT_TO_REPRESENT_TYPE_ID;
  }

  // Active ATS catalog rows (ats_binding_key set), split into the resolvable allowed set
  // (resolver order) and the keys that exist in the catalog but have no resolver.
  private async atsCatalog(): Promise<{ allowed: CatalogBinding[]; unresolvable: Set<string> }> {
    const rows = (await this.catalog.listActive()).filter((r) => r.ats_binding_key !== null);
    const allowed: CatalogBinding[] = [];
    const unresolvable = new Set<string>();
    for (const r of rows) {
      if (hasAtsResolver(r)) {
        allowed.push({
          key: r.key,
          label: r.label,
          group: r.group_label,
          sample: r.sample_value ?? '',
          data_type: r.data_type,
          sample_value: r.sample_value,
          active: r.active,
        });
      }
      else unresolvable.add(r.key);
    }
    allowed.sort((a, b) => resolverIndex(a.key) - resolverIndex(b.key));
    return { allowed, unresolvable };
  }

  async listAllowedBindings(documentTypeId: string): Promise<readonly TemplateBindingDescriptor[]> {
    if (!this.isConfigurable(documentTypeId)) return [];
    const { allowed } = await this.atsCatalog();
    // TEMPLATE-STUDIO-1 B-2 — additive data_type / sample_value / active. The offered set is
    // unchanged: only ACTIVE catalog rows with a resolver are bindable, so `active` is the
    // row's own flag (true for every offered binding today) — no inactive key is added.
    return allowed.map((d) => ({ key: d.key, label: d.label, group: d.group, data_type: d.data_type, sample_value: d.sample_value, active: d.active }));
  }

  async validateDraftContent(input: { document_type_id: string; field_schema: unknown; render_schema_version: string; requestId: string }): Promise<void> {
    if (!this.isConfigurable(input.document_type_id)) return; // non-configurable → nothing to validate
    await this.validateAgainst(await this.atsCatalog(), input);
  }

  // Structure + closed-binding validation against an already-loaded catalog (one catalog
  // read per request). Returns the parsed content for the preview.
  private async validateAgainst(
    cat: { allowed: CatalogBinding[]; unresolvable: Set<string> },
    input: { field_schema: unknown; render_schema_version: string; requestId: string },
  ): Promise<{ html: { content: RtrTemplateContentHtmlV1; nodes: HtmlNode[] } } | { v1: RtrTemplateContentV1 }> {
    const allowedKeys = new Set(cat.allowed.map((d) => d.key));
    if (input.render_schema_version === RTR_HTML_SCHEMA_V1) {
      return { html: this.validateHtml(input, allowedKeys, cat.unresolvable) };
    }
    const content = this.parse(input);
    if (content.title.trim() === '' || content.blocks.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'template content must have a title and at least one block', 400, { requestId: input.requestId });
    }
    for (const key of this.collectTokens(content)) {
      if (!allowedKeys.has(key)) {
        throw unsupportedBinding(input.requestId, key, cat.unresolvable.has(key) ? 'no_resolver' : undefined);
      }
    }
    return { v1: content };
  }

  async renderSamplePreview(input: {
    document_type_id: string;
    field_schema: unknown;
    render_schema_version: string;
    requestId: string;
    sample_overrides?: Readonly<Record<string, string>>;
  }): Promise<TemplateSamplePreview> {
    if (!this.isConfigurable(input.document_type_id)) {
      throw new AramoError('VALIDATION_ERROR', 'this document type is not configurable', 400, { requestId: input.requestId });
    }
    const cat = await this.atsCatalog();
    const parsed = await this.validateAgainst(cat, input); // validate structure + bindings first (fail closed)
    // DOC-TEMPLATE-LIB-1 T-4 — a tenant-branded preview replaces the sample of an allowed
    // key with the tenant's own value (organization.*); unknown keys are ignored.
    const overrides = input.sample_overrides ?? {};
    const valueOf = (d: CatalogBinding): string =>
      Object.prototype.hasOwnProperty.call(overrides, d.key) ? (overrides[d.key] as string) : d.sample;
    const samples = new Map(cat.allowed.map((d) => [d.key, valueOf(d)]));
    const sub = (text: string): string => text.replace(TOKEN_RE, (_whole, key: string) => samples.get(key) ?? `{{${key}}}`);
    const sample_values = cat.allowed.map((d) => ({ key: d.key, label: d.label, value: valueOf(d) }));
    const signature_block = { printed_name: samples.get('talent.full_name') ?? null };
    if ('html' in parsed) {
      const { content, nodes } = parsed.html;
      return {
        title: sub(content.title),
        blocks: [],
        html: htmlWithSamples(nodes, (key) => samples.get(key) ?? ''),
        logo: content.logo ? { asset_id: content.logo.asset_id } : null,
        sample_values,
        signature_block,
      };
    }
    const content = parsed.v1;
    return {
      title: sub(content.title),
      blocks: content.blocks.map((b) => ({ type: b.type, text: sub(b.text) })),
      // B2 — the fixed signature block (PRINTED NAME = the talent.full_name sample).
      signature_block,
      sample_values,
    };
  }

  // A1 §2.2 — PATCH-time authoritative sanitisation (rtr-html-v1 only). T-2: the
  // unknown-field check reads the catalog (active, resolvable keys).
  async normalizeDraftContent(input: {
    document_type_id: string;
    render_schema_version: string;
    field_schema: unknown;
    existing_field_schema: unknown;
    requestId: string;
  }): Promise<unknown> {
    if (!this.isConfigurable(input.document_type_id) || input.render_schema_version !== RTR_HTML_SCHEMA_V1) return input.field_schema;
    const fs = input.field_schema;
    if (fs === null || typeof fs !== 'object' || Array.isArray(fs)) throw htmlInvalid(input.requestId, 'content_invalid');
    const o = fs as Record<string, unknown>;
    if (typeof o.title !== 'string' || typeof o.html !== 'string') throw htmlInvalid(input.requestId, 'content_invalid');
    const allowedKeys = new Set((await this.atsCatalog()).allowed.map((d) => d.key));
    const res = sanitizeRtrHtml(o.html, (k) => allowedKeys.has(k));
    if ('issue' in res) throw htmlInvalid(input.requestId, res.issue.reason, res.issue.keys);
    // The logo reference is SERVER-OWNED: carried over from the existing content only.
    const existingLogo = parseLogoRef((input.existing_field_schema as Record<string, unknown> | null)?.['logo']);
    const content: RtrTemplateContentHtmlV1 = {
      render_schema_version: RTR_HTML_SCHEMA_V1,
      title: o.title.trim(),
      html: res.html,
      logo: existingLogo,
    };
    // Amendment M-A6 §3.2 — the signing roles are KEPT and validated (never stripped).
    // Absent ⇒ the draft's existing signing carries over (an editor that does not know
    // about roles never drops them); null ⇒ removed; anything else must validate.
    const rawSigning = Object.prototype.hasOwnProperty.call(o, 'signing')
      ? o['signing']
      : (input.existing_field_schema as Record<string, unknown> | null)?.['signing'];
    if (rawSigning !== undefined && rawSigning !== null) {
      const sg = parseSigningConfig(rawSigning);
      if ('issue' in sg) {
        throw new AramoError('VALIDATION_ERROR', `RTR template content rejected: ${sg.issue}`, 422, {
          requestId: input.requestId,
          details: { reason: sg.issue, ...(sg.index !== undefined ? { index: sg.index } : {}) },
        });
      }
      content.signing = sg.signing;
    }
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
  private validateHtml(
    input: { field_schema: unknown; requestId: string },
    allowedKeys: ReadonlySet<string>,
    unresolvable: ReadonlySet<string>,
  ): { content: RtrTemplateContentHtmlV1; nodes: HtmlNode[] } {
    const content = parseHtmlContent(input.field_schema);
    if (content === null) throw new AramoError('VALIDATION_ERROR', 'RTR html content is empty or invalid', 400, { requestId: input.requestId });
    const res = sanitizeRtrHtml(content.html, (k) => allowedKeys.has(k));
    if ('issue' in res) {
      if (res.issue.reason === 'unknown_field') {
        const keys = res.issue.keys ?? [];
        const noResolver = keys.length > 0 && keys.every((k) => unresolvable.has(k));
        throw new AramoError('TEMPLATE_BINDING_UNSUPPORTED', `template content references an unsupported binding: ${keys.join(', ')}`, 422, {
          requestId: input.requestId,
          details: { reason: noResolver ? 'no_resolver' : 'unknown_field', keys: res.issue.keys },
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
