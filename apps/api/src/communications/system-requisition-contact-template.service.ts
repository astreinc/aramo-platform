import { Injectable } from '@nestjs/common';

import {
  type HydratedDraft,
  type RequisitionContactContext,
  type RequisitionContactTemplateResolver,
} from './requisition-contact-template.port.js';

// COMM-C4 (RCE-1) — the single governed, code-owned requisition-contact template
// (auto-applied; no picker, no DB table, no tenant editing). Hydration is fully
// DETERMINISTIC: strings are built directly from resolved context values, so no
// raw `{placeholder}` token can survive and no wording is inferred. An
// unavailable field omits its block and records a factual, bounded warning.
// DEC-1: the optional role-summary block is a source-preserving excerpt of an
// authoritative requisition field — never an LLM summary/paraphrase.

const TEMPLATE_ID = 'system.requisition-contact.v1';
const TEMPLATE_VERSION = '1';

// Cap for the deterministic role-summary excerpt (characters).
const ROLE_SUMMARY_MAX = 400;

// Fixed, governed enum→label maps (template formatting, not inference); an
// unknown raw value falls back to itself.
const ENGAGEMENT_LABELS: Readonly<Record<string, string>> = {
  contract: 'Contract',
  contract_to_hire: 'Contract-to-Hire',
  contract_to_perm: 'Contract-to-Perm',
  direct_perm: 'Direct Hire',
};
const WORK_ARRANGEMENT_LABELS: Readonly<Record<string, string>> = {
  onsite: 'Onsite',
  hybrid: 'Hybrid',
  remote: 'Remote',
};

function label(map: Readonly<Record<string, string>>, raw: string | null): string | null {
  if (raw === null) return null;
  const key = raw.trim();
  if (key === '') return null;
  return map[key] ?? key;
}

function present(v: string | null): string | null {
  if (v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

// DEC-1 — deterministic, source-preserving excerpt: a short source is used
// whole; a long one is cut on the last sentence/paragraph boundary at or before
// the cap (never mid-word, never invented text). Null when there is no source.
function roleSummaryExcerpt(source: string | null): string | null {
  const text = present(source);
  if (text === null) return null;
  if (text.length <= ROLE_SUMMARY_MAX) return text;
  const window = text.slice(0, ROLE_SUMMARY_MAX);
  const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'));
  if (sentence > 0) return text.slice(0, sentence + 1).trim();
  const para = window.lastIndexOf('\n');
  if (para > 0) return text.slice(0, para).trim();
  const word = window.lastIndexOf(' ');
  return (word > 0 ? window.slice(0, word) : window).trim();
}

@Injectable()
export class SystemRequisitionContactTemplateService implements RequisitionContactTemplateResolver {
  resolveDefault(context: RequisitionContactContext): HydratedDraft {
    const warnings: string[] = [];

    const engagementLabel = label(ENGAGEMENT_LABELS, context.engagement_type);
    const workLabel = label(WORK_ARRANGEMENT_LABELS, context.work_arrangement);
    const locationShort = present(context.location_short);
    const location = present(context.location);
    const firstName = present(context.talent_first_name);
    const recruiter = present(context.recruiter_display_name);
    const company = present(context.tenant_recruiting_company_name);

    // Subject: title, plus location + engagement when available.
    let subject = context.requisition_title;
    if (locationShort !== null) subject += ` — ${locationShort}`;
    if (engagementLabel !== null) subject += ` (${engagementLabel})`;

    const lines: string[] = [];
    if (firstName !== null) {
      lines.push(`Hi ${firstName},`);
    } else {
      lines.push('Hi there,');
      warnings.push('talent_first_name_unavailable');
    }
    lines.push('');
    lines.push(
      `I'm reaching out regarding the ${context.requisition_title} opportunity (${context.requisition_reference}).`,
    );
    lines.push('');

    if (location !== null) {
      lines.push(workLabel !== null ? `Location: ${location} — ${workLabel}` : `Location: ${location}`);
    } else if (workLabel !== null) {
      lines.push(`Work arrangement: ${workLabel}`);
    } else {
      warnings.push('location_unavailable');
    }
    if (engagementLabel !== null) lines.push(`Engagement: ${engagementLabel}`);

    lines.push('');
    lines.push(
      "Based on your background, I'd like to connect with you to discuss the role and learn more about your experience and interest.",
    );

    const summary = roleSummaryExcerpt(context.role_summary_source);
    if (summary !== null) {
      lines.push('');
      lines.push('About the opportunity:');
      lines.push(summary);
    } else {
      warnings.push('role_summary_source_unavailable');
    }

    lines.push('');
    lines.push('Would you be open to a short call this week?');
    lines.push('');
    lines.push('Best regards,');
    if (recruiter !== null) {
      lines.push(recruiter);
    } else {
      warnings.push('recruiter_display_name_unavailable');
    }
    if (company !== null) {
      lines.push(company);
    } else {
      warnings.push('tenant_recruiting_company_name_unavailable');
    }

    return {
      subject,
      body: lines.join('\n'),
      template_id: TEMPLATE_ID,
      template_version: TEMPLATE_VERSION,
      warnings,
    };
  }
}
