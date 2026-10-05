import { Injectable } from '@nestjs/common';

import type { HydratedDraft } from './requisition-contact-template.port.js';
import {
  type GeneralTalentContactContext,
  type GeneralTalentContactTemplateResolver,
} from './general-talent-contact-template.port.js';

// COMM-RECRUITER-W1 (W1-A1) — the single governed, code-owned General Talent
// Contact default (Talent-only; auto-applied; tenant OVERRIDE via the existing
// EmailTemplate store, no picker). Hydration is fully DETERMINISTIC: strings are
// built directly from resolved context values, so no raw `{placeholder}` survives
// and no wording is inferred. GENDER-NEUTRAL BY CONSTRUCTION — direct second
// person only; NO he/she/him/her/his/hers. An unavailable field omits its block
// and records a factual, bounded `<field>_unavailable` warning. The closed binding
// catalog is exactly talent.first_name / recruiter.display_name / company.name
// (NO requisition context). The work-authorization line is a REPLY PROMPT only; it
// never writes TalentRecord.work_authorization.

export const SYSTEM_GENERAL_TALENT_CONTACT_TEMPLATE_ID = 'system.talent-general-contact.v1';
const TEMPLATE_ID = SYSTEM_GENERAL_TALENT_CONTACT_TEMPLATE_ID;
const TEMPLATE_VERSION = '1';

function present(v: string | null): string | null {
  if (v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

// COMM-RECRUITER-W1 §4B-cat — the authoritative token→value map for a tenant
// General Talent Contact OVERRIDE rendered against the SAME reloaded context the
// code default uses. Keys are the closed, requisition-free merge-field allowlist
// (GENERAL_TALENT_CONTACT_TOKENS); values are server-resolved (never
// browser-supplied).
export function buildGeneralTalentContactTemplateValues(
  context: GeneralTalentContactContext,
): Record<string, string | null> {
  return {
    'talent.first_name': present(context.talent_first_name),
    'recruiter.display_name': present(context.recruiter_display_name),
    'company.name': present(context.tenant_recruiting_company_name),
  };
}

@Injectable()
export class SystemGeneralTalentContactTemplateService implements GeneralTalentContactTemplateResolver {
  resolveDefault(context: GeneralTalentContactContext): HydratedDraft {
    const warnings = new Set<string>();

    const firstName = present(context.talent_first_name);
    const recruiter = present(context.recruiter_display_name);
    const company = present(context.tenant_recruiting_company_name);

    // Subject: company-qualified when available, else a plain requisition-free line.
    const subject =
      company !== null ? `${company} | Opportunities in your field` : 'Opportunities in your field';
    if (company === null) warnings.add('tenant_recruiting_company_name_unavailable');

    const lines: string[] = [];
    if (firstName !== null) {
      lines.push(`Hi ${firstName},`);
    } else {
      lines.push('Hi there,');
      warnings.add('talent_first_name_unavailable');
    }
    lines.push('');
    lines.push(
      company !== null
        ? `I'm reaching out from ${company} — based on your background, I'd like to connect about opportunities that may be relevant to your experience.`
        : "I'm reaching out — based on your background, I'd like to connect about opportunities that may be relevant to your experience.",
    );
    lines.push('');
    lines.push(
      "If you're open to it, please reply with your current availability and work authorization, and I can share specific roles and details right away.",
    );
    lines.push('');
    lines.push('Best regards,');
    if (recruiter !== null) {
      lines.push(recruiter);
    } else {
      warnings.add('recruiter_display_name_unavailable');
    }
    if (company !== null) {
      lines.push(company);
    }

    return {
      subject,
      body: lines.join('\n'),
      template_id: TEMPLATE_ID,
      template_version: TEMPLATE_VERSION,
      warnings: [...warnings],
    };
  }
}
