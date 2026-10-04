import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { type RenderModel } from '@aramo/documents-rendering';
import { TalentRecordRepository } from '@aramo/talent-record';

import { isRtrBindingKey, type RtrBindingKey, type RtrTemplateContentV1 } from './rtr-template-content.js';

// RTR-TEMPLATE-1 (§9, §10, INV-8/INV-9) — the server-owned RTR binding resolver.
//
// Takes the resolved template content (ordered HEADING/TEXT blocks whose text may
// embed {{binding.key}} tokens) + authoritative identifiers, resolves ONLY the
// closed binding catalog from authoritative repositories, and returns a fully
// RESOLVED RenderModel for the renderer. The renderer never queries ATS data
// (INV-8): all substitution happens here. No arbitrary expressions, no open
// traversal (INV-9) — a token outside the closed catalog is a configuration
// error; a required value that cannot be resolved fails closed BEFORE rendering,
// so a raw {{token}} or empty value can never reach the PDF (§9).

export interface RtrBindingInput {
  content: RtrTemplateContentV1;
  template_version_id: string;
  tenant_id: string;
  talent_id: string;
  requisition_id: string;
  company_id: string;
  requestId: string;
}

const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

@Injectable()
export class RtrTemplateBindingService {
  constructor(private readonly talent: TalentRecordRepository) {}

  async bind(input: RtrBindingInput): Promise<RenderModel> {
    const used = this.collectTokens([input.content.title, ...input.content.blocks.map((b) => b.text)], input.requestId);
    const values = await this.resolveValues(used, input);
    return {
      template_version_id: input.template_version_id,
      // The RENDERER's schema (flat resolved blocks) — distinct from the template
      // content-contract version (rtr-generated-v1). Values are already resolved.
      render_schema_version: 'v1',
      title: this.substitute(input.content.title, values, input.requestId),
      blocks: input.content.blocks.map((b) => ({ type: b.type, text: this.substitute(b.text, values, input.requestId) })),
    };
  }

  // Every {{token}} the content uses must be in the closed catalog, else the
  // template is misconfigured (an unknown/prohibited binding — INV-9).
  private collectTokens(texts: readonly string[], requestId: string): Set<RtrBindingKey> {
    const out = new Set<RtrBindingKey>();
    for (const text of texts) {
      for (const match of text.matchAll(TOKEN_RE)) {
        const key = match[1];
        if (key === undefined) continue;
        if (!isRtrBindingKey(key)) {
          throw new AramoError(
            'RTR_TEMPLATE_CONFIGURATION_INVALID',
            `RTR template references a binding outside the closed catalog: {{${key}}}`,
            422,
            { requestId, details: { reason: 'unknown_binding', binding_key: key } },
          );
        }
        out.add(key);
      }
    }
    return out;
  }

  // Resolve each used binding from its authoritative repository. A missing
  // required value fails closed (RTR_TEMPLATE_BINDING_MISSING). The switch is
  // exhaustive over the closed catalog — a catalog key with no branch is a
  // configuration error, never a silent empty value.
  private async resolveValues(used: Set<RtrBindingKey>, input: RtrBindingInput): Promise<Map<string, string>> {
    const values = new Map<string, string>();
    for (const key of used) {
      switch (key) {
        case 'talent.full_name': {
          const t = await this.talent.findById({ tenant_id: input.tenant_id, id: input.talent_id });
          const name = t === null ? '' : `${t.first_name} ${t.last_name}`.trim();
          if (name.length === 0) throw this.missing(key, input.requestId);
          values.set(key, name);
          break;
        }
        default: {
          throw new AramoError(
            'RTR_TEMPLATE_CONFIGURATION_INVALID',
            `no resolver is wired for RTR binding {{${key}}}`,
            422,
            { requestId: input.requestId, details: { reason: 'binding_resolver_missing', binding_key: key } },
          );
        }
      }
    }
    return values;
  }

  // Replace every token with its resolved value. A token without a resolved value
  // throws rather than leaving a raw {{token}} in the output (defense in depth).
  private substitute(text: string, values: Map<string, string>, requestId: string): string {
    return text.replace(TOKEN_RE, (_whole, key: string) => {
      const value = values.get(key);
      if (value === undefined) throw this.missing(key, requestId);
      return value;
    });
  }

  private missing(key: string, requestId: string): AramoError {
    return new AramoError(
      'RTR_TEMPLATE_BINDING_MISSING',
      `required RTR binding {{${key}}} could not be resolved to an authoritative value`,
      422,
      { requestId, details: { binding_key: key } },
    );
  }
}
