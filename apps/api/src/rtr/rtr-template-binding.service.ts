import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { type LetterheadModel, type RenderModel } from '@aramo/documents-rendering';
import { TalentRecordRepository } from '@aramo/talent-record';
import { RequisitionRepository } from '@aramo/requisition';
import { CompanyRepository } from '@aramo/company';
import { IdentityRepository, TenantRepository } from '@aramo/identity';

import { isRtrBindingKey, type RtrBindingKey } from './rtr-template-content.js';
import {
  collectFieldKeys,
  htmlWithSamples,
  isHtmlContent,
  sanitizeRtrHtml,
  toRichBlocks,
  type RtrTemplateContent,
} from './rtr-html-content.js';

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
  // A1 §2.1 — rtr-generated-v1 (title + HEADING/TEXT) or rtr-html-v1 (title + allowlisted html).
  content: RtrTemplateContent;
  // A1 §2.4 — the version's FROZEN logo (bytes read by the orchestrator from the
  // TemplateAsset, sha-verified). Only meaningful for rtr-html-v1 content.
  letterhead?: LetterheadModel;
  template_version_id: string;
  tenant_id: string;
  talent_id: string;
  requisition_id: string;
  company_id: string;
  // DOC-TEMPLATE-ADMIN-RTR-1 (§13 ruling) — the SENDING recruiter (created_by), the
  // authority for recruiter.display_name. Not the requisition owner.
  recruiter_user_id: string;
  requestId: string;
}

const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

@Injectable()
export class RtrTemplateBindingService {
  constructor(
    private readonly talent: TalentRecordRepository,
    private readonly requisitions: RequisitionRepository,
    private readonly companies: CompanyRepository,
    private readonly tenants: TenantRepository,
    private readonly identity: IdentityRepository,
  ) {}

  async bind(input: RtrBindingInput): Promise<RenderModel & { signature_block: { printed_name: string }; bound_html?: string }> {
    if (isHtmlContent(input.content)) return this.bindHtml(input, input.content);
    const content = input.content;
    const used = this.collectTokens([content.title, ...content.blocks.map((b) => b.text)], input.requestId);
    // B2 (spec §9.3) — the fixed signature block's PRINTED NAME is the bound
    // talent.full_name for EVERY version, whether or not the content references it, so it
    // is always resolved (fail closed when missing, like any other binding).
    used.add('talent.full_name');
    const values = await this.resolveValues(used, input);
    // DOC-TEMPLATE-LIB-1 T-3 (§4.3) — an Aramo default rendered for this tenant may carry
    // the tenant's letterhead (logo captured at render by the orchestrator). A tenant's
    // own rtr-generated-v1 content never receives one, so its output is byte-identical.
    const letterhead = input.letterhead !== undefined ? await this.namedLetterhead(input.tenant_id, input.letterhead) : undefined;
    return {
      template_version_id: input.template_version_id,
      // The RENDERER's schema (flat resolved blocks) — distinct from the template
      // content-contract version (rtr-generated-v1). Values are already resolved.
      render_schema_version: 'v1',
      title: this.substitute(content.title, values, input.requestId),
      blocks: content.blocks.map((b) => ({ type: b.type, text: this.substitute(b.text, values, input.requestId) })),
      ...(letterhead !== undefined ? { letterhead } : {}),
      signature_block: { printed_name: values.get('talent.full_name') as string },
    };
  }

  // A1 §2.4 / DOC-TEMPLATE-LIB-1 §4.3 — the organisation name beside the letterhead logo:
  // the tenant's branding label (display_name), else its legal name, else the workspace name.
  private async namedLetterhead(tenant_id: string, letterhead: LetterheadModel): Promise<LetterheadModel> {
    const name = organizationName(await this.tenants.findBrandingById(tenant_id));
    return { ...letterhead, name };
  }

  // A1 §2.3 — rtr-html-v1: keys come from the data-field nodes (same closed catalog, same
  // fail-closed rules); bound values are substituted as PLAIN TEXT inside the styled runs.
  // The html is re-sanitised here (defence in depth) — a non-clean stored html fails
  // closed as a configuration error.
  private async bindHtml(
    input: RtrBindingInput,
    content: Extract<RtrTemplateContent, { render_schema_version: 'rtr-html-v1' }>,
  ): Promise<RenderModel & { signature_block: { printed_name: string }; bound_html: string }> {
    const res = sanitizeRtrHtml(content.html);
    if ('issue' in res) {
      throw new AramoError('RTR_TEMPLATE_CONFIGURATION_INVALID', `RTR template content is not usable: ${res.issue.reason}`, 422, {
        requestId: input.requestId,
        details: { reason: res.issue.reason, ...(res.issue.keys !== undefined ? { keys: res.issue.keys } : {}) },
      });
    }
    const used = this.collectTokens([content.title], input.requestId);
    for (const key of collectFieldKeys(res.nodes)) {
      if (!isRtrBindingKey(key)) {
        throw new AramoError('RTR_TEMPLATE_CONFIGURATION_INVALID', `RTR template references a binding outside the closed catalog: ${key}`, 422, {
          requestId: input.requestId,
          details: { reason: 'unknown_binding', binding_key: key },
        });
      }
      used.add(key);
    }
    used.add('talent.full_name');
    const values = await this.resolveValues(used, input);
    // A1 §2.4 — the organisation name beside the letterhead logo: the tenant's branding
    // label (display_name), else its legal name, else the workspace name.
    const letterhead = input.letterhead !== undefined ? await this.namedLetterhead(input.tenant_id, input.letterhead) : undefined;
    const value = (key: string): string => {
      const v = values.get(key);
      if (v === undefined) throw this.missing(key, input.requestId);
      return v;
    };
    return {
      template_version_id: input.template_version_id,
      render_schema_version: 'rich-v1',
      title: this.substitute(content.title, values, input.requestId),
      blocks: [],
      rich_blocks: toRichBlocks(res.nodes, value),
      ...(letterhead !== undefined ? { letterhead } : {}),
      signature_block: { printed_name: values.get('talent.full_name') as string },
      // The bound content as allowlisted html (field nodes → <span data-sample> with the
      // REAL value) for the recruiter compose preview. Never rendered by the PDF path.
      bound_html: htmlWithSamples(res.nodes, value),
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
    // Memoize the requisition read — title + reference both derive from it (one query).
    type ReqFacts = { title: string; requisition_number: number; description: string | null };
    let reqPromise: Promise<ReqFacts | null> | undefined;
    const getReq = (): Promise<ReqFacts | null> => {
      if (reqPromise === undefined) {
        reqPromise = this.requisitions
          .findByIdAdmin({ tenant_id: input.tenant_id, id: input.requisition_id })
          .then((r) =>
            r === null
              ? null
              : { title: r.title, requisition_number: r.requisition_number, description: r.description ?? null },
          );
      }
      return reqPromise;
    };
    // DOC-TEMPLATE-LIB-1 T-3 — memoize the tenant-profile read (organization.* keys).
    type Branding = Awaited<ReturnType<TenantRepository['findBrandingById']>>;
    let brandingPromise: Promise<Branding> | undefined;
    const getBranding = (): Promise<Branding> => {
      if (brandingPromise === undefined) brandingPromise = this.tenants.findBrandingById(input.tenant_id);
      return brandingPromise;
    };
    const setOrganization = async (key: RtrBindingKey, pick: (b: NonNullable<Branding>) => string | null): Promise<void> => {
      const b = await getBranding();
      const v = (b === null ? '' : (pick(b) ?? '')).trim();
      if (v.length === 0) throw this.missing(key, input.requestId);
      values.set(key, v);
    };
    // Memoize the talent read — full_name + desired_pay_rate both derive from it.
    let talentPromise: ReturnType<TalentRecordRepository['findById']> | undefined;
    const getTalent = (): ReturnType<TalentRecordRepository['findById']> => {
      if (talentPromise === undefined) talentPromise = this.talent.findById({ tenant_id: input.tenant_id, id: input.talent_id });
      return talentPromise;
    };
    for (const key of used) {
      switch (key) {
        case 'talent.full_name': {
          const t = await getTalent();
          const name = t === null ? '' : `${t.first_name} ${t.last_name}`.trim();
          if (name.length === 0) throw this.missing(key, input.requestId);
          values.set(key, name);
          break;
        }
        case 'talent.desired_pay_rate': {
          // Amendment A2 — TalentRecord.desired_pay printed as recorded (leading `$` when it
          // starts with a digit or '.'). The talent's STATED desired rate — never an agreed
          // rate, never agreed_pay_rate.*. Blank/null ⇒ MISSING (fail closed).
          const t = await getTalent();
          const pay = formatDesiredPayRate(t?.desired_pay ?? null);
          if (pay === null) throw this.missing(key, input.requestId);
          values.set(key, pay);
          break;
        }
        case 'client.name': {
          // The CLIENT company associated with the requisition (company_id supplied by the
          // authorized RTR request). Never an arbitrary Company.
          const names = await this.companies.findNamesByIds({ tenant_id: input.tenant_id, ids: [input.company_id] });
          const name = (names.get(input.company_id) ?? '').trim();
          if (name.length === 0) throw this.missing(key, input.requestId);
          values.set(key, name);
          break;
        }
        case 'requisition.title': {
          const req = await getReq();
          const title = (req?.title ?? '').trim();
          if (title.length === 0) throw this.missing(key, input.requestId);
          values.set(key, title);
          break;
        }
        case 'requisition.reference': {
          // Ruling: requisition_number (REQ-N), never the nullable external_req_id.
          const req = await getReq();
          if (req === null) throw this.missing(key, input.requestId);
          values.set(key, `REQ-${req.requisition_number}`);
          break;
        }
        case 'requisition.description': {
          // Slice 1 B3 — the exact Requisition's description, flattened to plain text
          // (markup stripped, whitespace normalised, paragraph breaks kept). Null/blank ⇒
          // MISSING (fail closed); never substituted from another field.
          const req = await getReq();
          const text = flattenToPlainText(req?.description ?? '');
          if (text.length === 0) throw this.missing(key, input.requestId);
          values.set(key, text);
          break;
        }
        case 'recruiting_company.name': {
          // PO ruling 2026-10-16 — the tenant's LEGAL name (Tenant.legal_name). Null ⇒
          // MISSING (fail closed); never the workspace name or display_name.
          const legal = ((await this.tenants.findLegalNameById(input.tenant_id)) ?? '').trim();
          if (legal.length === 0) throw this.missing(key, input.requestId);
          values.set(key, legal);
          break;
        }
        case 'recruiter.display_name': {
          // Ruling: the SENDING recruiter (created_by), not the requisition owner.
          const user = await this.identity.findUserById(input.recruiter_user_id);
          const name = (user?.display_name ?? '').trim();
          if (name.length === 0) throw this.missing(key, input.requestId);
          values.set(key, name);
          break;
        }
        // DOC-TEMPLATE-LIB-1 T-3 (§4.3) — organization (tenant profile) variables.
        case 'organization.name': {
          const name = organizationName(await getBranding());
          if (name === null) throw this.missing(key, input.requestId);
          values.set(key, name);
          break;
        }
        case 'organization.address_line1':
          await setOrganization(key, (b) => b.address_line1);
          break;
        case 'organization.address_line2':
          await setOrganization(key, (b) => b.address_line2);
          break;
        case 'organization.city':
          await setOrganization(key, (b) => b.city);
          break;
        case 'organization.region':
          await setOrganization(key, (b) => b.state_province);
          break;
        case 'organization.postal_code':
          await setOrganization(key, (b) => b.postal_code);
          break;
        case 'organization.country':
          await setOrganization(key, (b) => b.country_code);
          break;
        default: {
          // Defense: a catalog key added without a resolver branch fails closed (never a
          // raw token / empty value in the PDF). Unreachable while the catalog + switch agree.
          throw new AramoError(
            'RTR_TEMPLATE_CONFIGURATION_INVALID',
            `no resolver is wired for RTR binding {{${key as string}}}`,
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

// The tenant's organisation name: branding label (display_name), else legal name, else the
// workspace name. Null when none is on record (unknown tenant).
export function organizationName(
  b: { name: string; display_name: string | null; legal_name: string | null } | null,
): string | null {
  const name = (b?.display_name ?? '').trim() || (b?.legal_name ?? '').trim() || (b?.name ?? '').trim();
  return name.length > 0 ? name : null;
}

// Slice 1 B3 — flatten a (possibly HTML / rich-text) description to plain text for the
// PDF: block-level tags and <br> become line breaks, every other tag is dropped, the
// common entities are decoded, runs of spaces/tabs collapse to one space per line, and
// 3+ consecutive line breaks collapse to one blank line (paragraph break). Pure.
export function flattenToPlainText(input: string): string {
  const withBreaks = input
    .replace(/\r\n?/g, '\n')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol|blockquote|table|section|article)\s*>/gi, '\n\n')
    .replace(/<\s*\/\s*(li|tr)\s*>/gi, '\n')
    .replace(/<\s*li(\s[^>]*)?>/gi, '\u2022 ')
    .replace(/<[^>]*>/g, '');
  const decoded = withBreaks
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
  const lines = decoded.split('\n').map((l) => l.replace(/[ \t\f\v\u00a0]+/g, ' ').trim());
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Amendment A2 — the app's desired-pay display rule: printed as recorded, with a leading
// `$` when the trimmed value starts with a digit or '.'; a value that already carries a
// currency/prefix (e.g. "$70/hr", "USD 70/hr", "INR 1,00,000") passes through unchanged.
// Blank/null → null (the caller fails closed).
export function formatDesiredPayRate(raw: string | null): string | null {
  const v = (raw ?? '').trim();
  if (v.length === 0) return null;
  return /^[0-9.]/.test(v) ? `$${v}` : v;
}
