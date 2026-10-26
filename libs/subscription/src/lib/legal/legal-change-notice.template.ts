import { createHash } from 'node:crypto';

import {
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_TITLES,
  approvedLegalDocument,
  type LegalDocumentKey,
  type LegalDocumentVersion,
} from './legal-documents.js';

// Privacy Notice 1.1 remediation E-6 (Aramo-Privacy-Notice-1_1-Remediation-Directive-v1_0-LOCKED,
// decision 7, section 3) — the account-holder notice of an upcoming legal-document change.
//
// The notice is a TEMPLATE with an id and a version. The delivery evidence records the template
// id, version and SHA-256 (templateSha256) and never the rendered body. The text below is a DRAFT
// pending counsel and PO approval: while LEGAL_CHANGE_NOTICE_TEMPLATE.status is DRAFT, the send
// mode refuses to run unless the operator confirms, by exact id@version, that this text has been
// approved for sending (assertTemplateSendable). Changing any text below requires a new version.

export type LegalChangeNoticeTemplateStatus = 'DRAFT' | 'APPROVED';

export interface LegalChangeNoticeTemplate {
  readonly id: string;
  readonly version: string;
  readonly status: LegalChangeNoticeTemplateStatus;
}

export const LEGAL_CHANGE_NOTICE_TEMPLATE: LegalChangeNoticeTemplate = {
  id: 'aramo.legal_change_notice',
  version: '0.1.0',
  // DRAFT pending counsel and PO approval of the exact text (the subject, the body below and the
  // change summary for the document version being announced).
  status: 'DRAFT',
};

/** The minimum notice period for a material change (Privacy Notice 1.0 §16: at least 30 days). */
export const LEGAL_CHANGE_MIN_NOTICE_DAYS = 30;

export const LEGAL_CHANGE_CONTACT = 'privacy@aramo.ai';

/**
 * The high-level "what is changing" lines, per document@version. DRAFT text, part of the template
 * (it is hashed into templateSha256). A notice for a version with no summary here is refused.
 */
export const LEGAL_CHANGE_SUMMARIES: Readonly<Record<string, readonly string[]>> = {
  'aramo.privacy_notice@1.1': [
    'It now covers the Aramo Sign mobile app for iPhone and Android: what the app keeps on your phone and on our servers, notifications when a document needs you, and saved signatures and contacts.',
    'It updates the list of service providers we use, including Apple and Google for app notifications and Google and Microsoft for signing in to the app.',
    'It says how long we keep app sign-in records, saved signatures and contacts, and other convenience data, and when we delete them.',
    'It makes clear that convenience data, such as a saved signature, is not part of a signed document’s record.',
  ],
};

/** Who a change to this document concerns: every account holder, or Personal accounts only. */
export function legalChangeAudience(key: LegalDocumentKey): 'ALL' | 'PERSONAL' {
  return key === 'sign.personal_terms_of_service' ? 'PERSONAL' : 'ALL';
}

export class LegalChangeNoticeRefusedError extends Error {
  constructor(
    readonly refusal: string,
    message: string,
  ) {
    super(message);
    this.name = 'LegalChangeNoticeRefusedError';
  }
}

const VERSION_PATTERN = /^\d+\.\d+(\.\d+)?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Parse YYYY-MM-DD as a calendar date (UTC midnight); null when malformed or not a real date. */
export function parseCalendarDate(raw: string): Date | null {
  if (!DATE_PATTERN.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return null;
  return d;
}

/** Whole calendar days (UTC) from `now`'s date to `effective`. */
export function calendarDaysUntil(effective: Date, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((effective.getTime() - today) / 86_400_000);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "25 November 2026" (UTC). */
export function formatNoticeDate(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export interface LegalChangeNoticeSubject extends LegalChangeLinks {
  effective_date: Date;
  summary: readonly string[];
}

export interface LegalChangeLinks {
  key: LegalDocumentKey;
  title: string;
  version: string;
  current: LegalDocumentVersion;
  current_url: string;
  upcoming_url: string;
}

/**
 * The document, its currently effective (APPROVED, published) version and the public URLs of the
 * current and the announced version. Refuses an unknown key, a malformed version, a document with
 * no APPROVED published version, and a "new" version equal to the current one.
 */
export function describeLegalChange(document_key: string, version: string, registry: readonly LegalDocumentVersion[] = LEGAL_DOCUMENTS): LegalChangeLinks {
  if (!Object.prototype.hasOwnProperty.call(LEGAL_DOCUMENT_TITLES, document_key)) {
    throw new LegalChangeNoticeRefusedError('unknown_document', `Unknown legal document key: ${document_key}`);
  }
  const key = document_key as LegalDocumentKey;
  if (!VERSION_PATTERN.test(version)) {
    throw new LegalChangeNoticeRefusedError('invalid_version', `Version must look like 1.1 or 1.1.0 (got ${version})`);
  }
  const current = approvedLegalDocument(key, registry);
  if (current === null || current.url === null) {
    throw new LegalChangeNoticeRefusedError('no_current_version', `${key} has no APPROVED published version to change from`);
  }
  if (current.version === version) {
    throw new LegalChangeNoticeRefusedError('version_is_current', `${key}@${version} is already the current version`);
  }
  const m = /^(https:\/\/[^/]+)\/legal\/([a-z0-9-]+)\/[^/]+$/.exec(current.url);
  if (m === null) {
    throw new LegalChangeNoticeRefusedError('no_current_version', `${key} current URL has no /legal/<slug>/<version> form`);
  }
  return {
    key,
    title: LEGAL_DOCUMENT_TITLES[key],
    version,
    current,
    current_url: current.url,
    upcoming_url: `${m[1]}/legal/${m[2]}/${version}`,
  };
}

/**
 * Resolve and validate what a notice announces: describeLegalChange, a summary for that version in
 * the template, and an effective date at least LEGAL_CHANGE_MIN_NOTICE_DAYS calendar days after
 * `now` (UTC dates).
 */
export function resolveLegalChangeNotice(
  input: { document_key: string; version: string; effective_date: string; now: Date },
  registry: readonly LegalDocumentVersion[] = LEGAL_DOCUMENTS,
  summaries: Readonly<Record<string, readonly string[]>> = LEGAL_CHANGE_SUMMARIES,
): LegalChangeNoticeSubject {
  const links = describeLegalChange(input.document_key, input.version, registry);
  const effective = parseCalendarDate(input.effective_date);
  if (effective === null) {
    throw new LegalChangeNoticeRefusedError('invalid_effective_date', `Effective date must be YYYY-MM-DD (got ${input.effective_date})`);
  }
  const summary = summaries[`${links.key}@${input.version}`];
  if (summary === undefined || summary.length === 0) {
    throw new LegalChangeNoticeRefusedError('no_change_summary', `No change summary for ${links.key}@${input.version} in the notice template`);
  }
  const days = calendarDaysUntil(effective, input.now);
  if (days < LEGAL_CHANGE_MIN_NOTICE_DAYS) {
    throw new LegalChangeNoticeRefusedError(
      'notice_period_too_short',
      `The effective date must be at least ${LEGAL_CHANGE_MIN_NOTICE_DAYS} days after today (got ${days} days)`,
    );
  }
  return { ...links, effective_date: effective, summary };
}

/** SHA-256 of the template text that produces a notice for this document version. */
export function templateSha256(
  key: string,
  version: string,
  template: LegalChangeNoticeTemplate = LEGAL_CHANGE_NOTICE_TEMPLATE,
  summaries: Readonly<Record<string, readonly string[]>> = LEGAL_CHANGE_SUMMARIES,
): string {
  const canonical = JSON.stringify({
    id: template.id,
    version: template.version,
    subject: SUBJECT_TEMPLATE,
    paragraphs: PARAGRAPH_TEMPLATES,
    contact: LEGAL_CHANGE_CONTACT,
    summary: summaries[`${key}@${version}`] ?? [],
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * The send-mode approval guard. A DRAFT template is refused unless `approvedTemplate` names the
 * exact template (id@version) — the operator's confirmation that counsel and the PO approved it.
 */
export function assertTemplateSendable(approvedTemplate: string | null, template: LegalChangeNoticeTemplate = LEGAL_CHANGE_NOTICE_TEMPLATE): void {
  const ref = `${template.id}@${template.version}`;
  if (approvedTemplate !== null && approvedTemplate !== ref) {
    throw new LegalChangeNoticeRefusedError('template_mismatch', `--approved-template must name the current template exactly (${ref})`);
  }
  if (template.status === 'DRAFT' && approvedTemplate !== ref) {
    throw new LegalChangeNoticeRefusedError(
      'template_draft',
      `The notice template ${ref} is DRAFT pending counsel and PO approval. Pass --approved-template=${ref} only once that approval exists.`,
    );
  }
}

// The template text. {title}, {version}, {effective}, {upcoming_url}, {current_version},
// {current_url} and {contact} are filled in; the summary lines follow the first paragraph.
const SUBJECT_TEMPLATE = 'We are updating the {title}';
const PARAGRAPH_TEMPLATES = [
  'We are updating the {title}. Version {version} takes effect on {effective}. Until then, version {current_version} continues to apply.',
  'What is changing, in summary:',
  'Read the new version: {upcoming_url}',
  'The current version stays available at: {current_url}',
  'You are receiving this because you have an Aramo account, and we notify account holders of important changes at least 30 days before they take effect. If you keep using Aramo on or after {effective}, the new version applies to you.',
  'Questions? Contact us at {contact}.',
] as const;

export interface RenderedLegalChangeNotice {
  subject: string;
  html: string;
  text: string;
}

function fill(s: string, n: LegalChangeNoticeSubject): string {
  return s
    .replaceAll('{title}', n.title)
    .replaceAll('{version}', n.version)
    .replaceAll('{effective}', formatNoticeDate(n.effective_date))
    .replaceAll('{upcoming_url}', n.upcoming_url)
    .replaceAll('{current_version}', n.current.version)
    .replaceAll('{current_url}', n.current_url)
    .replaceAll('{contact}', LEGAL_CHANGE_CONTACT);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Render the notice. Identical for every recipient (no personal data in the body). */
export function renderLegalChangeNotice(n: LegalChangeNoticeSubject): RenderedLegalChangeNotice {
  const [intro, whatLead, , , why] = PARAGRAPH_TEMPLATES.map((p) => fill(p, n));
  const [readNew, current, contact] = [PARAGRAPH_TEMPLATES[2], PARAGRAPH_TEMPLATES[3], PARAGRAPH_TEMPLATES[5]].map((p) => fill(p, n));
  const subject = fill(SUBJECT_TEMPLATE, n);
  const text = [intro, '', whatLead, ...n.summary.map((l) => `- ${l}`), '', readNew, current, '', why, '', contact].join('\n');
  const link = (url: string) => `<a href="${esc(url)}">${esc(url)}</a>`;
  const html = [
    '<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#1f2933">',
    `<p>${esc(intro!)}</p>`,
    `<p>${esc(whatLead!)}</p>`,
    `<ul>${n.summary.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`,
    `<p>Read the new version: ${link(n.upcoming_url)}</p>`,
    `<p>The current version stays available at: ${link(n.current_url)}</p>`,
    `<p>${esc(why!)}</p>`,
    `<p>Questions? Contact us at <a href="mailto:${LEGAL_CHANGE_CONTACT}">${LEGAL_CHANGE_CONTACT}</a>.</p>`,
    '</body></html>',
  ].join('');
  return { subject, html, text };
}
