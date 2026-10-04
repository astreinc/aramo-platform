import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { TemplatesRepository } from '@aramo/documents';

import { RIGHT_TO_REPRESENT_TYPE_ID } from './rtr-constants.js';
import {
  RTR_GENERATED_SCHEMA_V1,
  type RtrContentBlock,
  type RtrTemplateContentV1,
} from './rtr-template-content.js';

// RTR-TEMPLATE-1 (§6, §10, §27) — the server-authoritative RTR template resolver.
//
// Resolves the ONE tenant-wide ACTIVE RIGHT_TO_REPRESENT template and PINS the
// exact current TemplateVersion. Selection is backend-authoritative (INV-1): the
// FE never names a template/version. current_version_id is the authority (§27) —
// never "first ACTIVE row" or "latest created." Every precondition fails CLOSED
// with a typed configuration refusal; there is NO inline-content fallback (INV-12).
//
// The resolved content (version.field_schema parsed as the rtr-generated-v1
// contract) + the pinned version id flow to the binding service (RTR-T2), which
// substitutes the closed binding catalog and renders. This resolver performs NO
// ATS-data access and NO rendering — it is pure template/version resolution.

export interface ResolvedRtrTemplate {
  template_id: string;
  template_version_id: string;
  template_name: string;
  version_number: number;
  render_schema_version: string;
  content: RtrTemplateContentV1;
}

@Injectable()
export class RtrTemplateResolverService {
  constructor(private readonly templates: TemplatesRepository) {}

  async resolveActive(input: { tenant_id: string; requestId: string }): Promise<ResolvedRtrTemplate> {
    const template = await this.templates.findActiveTenantTemplateForType(
      input.tenant_id,
      RIGHT_TO_REPRESENT_TYPE_ID,
    );
    if (template === null) {
      throw new AramoError(
        'RTR_TEMPLATE_NOT_CONFIGURED',
        'No active Right to Represent template is configured for this tenant',
        409,
        {
          requestId: input.requestId,
          details: { tenant_id: input.tenant_id, document_type_id: RIGHT_TO_REPRESENT_TYPE_ID },
        },
      );
    }

    // current_version_id is authoritative (§27). Absent ⇒ misconfigured, not "pick one".
    if (template.current_version_id === null) {
      throw this.invalid(input.requestId, template.id, 'current_version_id_null');
    }

    const version = await this.templates.findVersionById(input.tenant_id, template.current_version_id);
    if (version === null) {
      throw this.invalid(input.requestId, template.id, 'current_version_missing');
    }
    if (version.template_id !== template.id) {
      throw this.invalid(input.requestId, template.id, 'current_version_foreign');
    }
    if (version.status !== 'ACTIVE') {
      throw this.invalid(input.requestId, template.id, 'current_version_not_active', { status: version.status });
    }
    // Unrecognised content-contract version ⇒ fail closed (§8): never interpret.
    if (version.render_schema_version !== RTR_GENERATED_SCHEMA_V1) {
      throw this.invalid(input.requestId, template.id, 'unrecognised_render_schema_version', {
        render_schema_version: version.render_schema_version,
      });
    }

    const content = this.parseContent(version.field_schema);
    if (content === null) {
      throw this.invalid(input.requestId, template.id, 'content_schema_invalid');
    }

    return {
      template_id: template.id,
      template_version_id: version.id,
      template_name: template.name,
      version_number: version.version_number,
      render_schema_version: version.render_schema_version,
      content,
    };
  }

  private invalid(
    requestId: string,
    template_id: string,
    reason: string,
    extra?: Record<string, unknown>,
  ): AramoError {
    return new AramoError(
      'RTR_TEMPLATE_CONFIGURATION_INVALID',
      'The active Right to Represent template is not usable (configuration invalid)',
      422,
      { requestId, details: { template_id, reason, ...(extra ?? {}) } },
    );
  }

  // Structural validation of the stored field_schema against the rtr-generated-v1
  // contract. Closed shape only (INV-9): title + ordered HEADING/TEXT blocks with
  // string text. Returns null on any structural mismatch (caller fails closed).
  private parseContent(fieldSchema: unknown): RtrTemplateContentV1 | null {
    if (typeof fieldSchema !== 'object' || fieldSchema === null) return null;
    const obj = fieldSchema as Record<string, unknown>;
    if (obj.render_schema_version !== RTR_GENERATED_SCHEMA_V1) return null;
    if (typeof obj.title !== 'string' || obj.title.length === 0) return null;
    if (!Array.isArray(obj.blocks) || obj.blocks.length === 0) return null;
    const blocks: RtrContentBlock[] = [];
    for (const raw of obj.blocks) {
      if (typeof raw !== 'object' || raw === null) return null;
      const b = raw as Record<string, unknown>;
      if (b.type !== 'HEADING' && b.type !== 'TEXT') return null;
      if (typeof b.text !== 'string') return null;
      blocks.push({ type: b.type, text: b.text });
    }
    return { render_schema_version: RTR_GENERATED_SCHEMA_V1, title: obj.title, blocks };
  }
}
