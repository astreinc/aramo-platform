import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type {
  TemplateBindingDescriptor,
  TemplateCapabilitiesPort,
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
import { RIGHT_TO_REPRESENT_TYPE_ID } from './rtr-constants.js';

// DOC-TEMPLATE-ADMIN-RTR-1 — the RTR implementation of the generic template-content
// capability port (§14/§15/§17). PURE: the closed RTR binding catalog + fixed sample
// values; no repositories, no renderer, no storage — admin preview uses SAMPLE data and
// never touches authoritative facts or creates a business Document. RTR is the only
// configurable document type this increment; every other type is a no-op / empty.

const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

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
    const content = this.parse(input);
    const sub = (text: string): string =>
      text.replace(TOKEN_RE, (_whole, key: string) => (isRtrBindingKey(key) ? RTR_BINDING_SAMPLE_VALUES[key as RtrBindingKey] : `{{${key}}}`));
    return { title: sub(content.title), blocks: content.blocks.map((b) => ({ type: b.type, text: sub(b.text) })) };
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
