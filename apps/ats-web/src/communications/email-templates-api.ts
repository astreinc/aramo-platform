// D-EMAIL-TPL-1 (ET-6) — reusable email-template MANAGEMENT client (ats-web,
// Settings → Communication → Email & notifications). Consumes the ET-4 APIs; NO
// template business logic lives here (rendering, merge-token validation, and the
// system-default-vs-override decision are all server-authoritative). Types are
// hand-mirrored — apps/ats-web must NOT import @aramo/communications (a forbidden
// domain edge) — and track the OpenAPI EmailTemplateView / EmailTemplatePreview.

import { apiClient } from '@aramo/fe-foundation';

const BASE = '/v1/communications/email-templates';

/** Effective template row. id === null marks the code-owned system default, which
 *  is READ-ONLY (D-1): editing it creates a tenant override rather than mutating. */
export interface EmailTemplateView {
  readonly id: string | null;
  readonly template_key: string;
  readonly category: string;
  readonly name: string;
  readonly subject_template: string;
  readonly body_template: string;
  readonly is_system_default: boolean;
  readonly is_active: boolean;
  readonly updated_at: string | null;
}

export interface EmailTemplatePreview {
  readonly subject: string;
  readonly body: string;
  readonly warnings: readonly string[];
}

export interface CreateEmailTemplateInput {
  readonly category: string;
  readonly name: string;
  readonly subject_template: string;
  readonly body_template: string;
}

export interface UpdateEmailTemplateInput {
  readonly name?: string;
  readonly subject_template?: string;
  readonly body_template?: string;
}

export interface PreviewEmailTemplateInput {
  readonly subject_template: string;
  readonly body_template: string;
}

/** The closed merge-field allowlist, hand-mirrored from the server renderer
 *  (EMAIL_TEMPLATE_TOKENS, ET-3). Labels are FE presentation only; the server is
 *  the authority on what actually resolves. `recruiter.email` is intentionally
 *  absent (no authoritative recruiter email in the context). */
export const MERGE_FIELD_REFERENCE: readonly { readonly token: string; readonly label: string }[] = [
  { token: '{{talent.first_name}}', label: 'Talent first name' },
  { token: '{{requisition.title}}', label: 'Requisition title' },
  { token: '{{requisition.reference}}', label: 'Requisition reference (REQ-…)' },
  { token: '{{requisition.location}}', label: 'Requisition location' },
  { token: '{{requisition.engagement_type}}', label: 'Engagement type' },
  { token: '{{requisition.work_arrangement}}', label: 'Work arrangement' },
  { token: '{{recruiter.display_name}}', label: 'Recruiter name' },
  { token: '{{company.name}}', label: 'Your company name' },
  { token: '{{role.summary_excerpt}}', label: 'Role summary excerpt' },
];

export async function listEmailTemplates(): Promise<readonly EmailTemplateView[]> {
  const res = await apiClient.get<{ items: EmailTemplateView[] }>(BASE);
  return res.items;
}

export async function createEmailTemplate(input: CreateEmailTemplateInput): Promise<EmailTemplateView> {
  return apiClient.post<EmailTemplateView>(BASE, input);
}

export async function updateEmailTemplate(
  id: string,
  input: UpdateEmailTemplateInput,
): Promise<EmailTemplateView> {
  return apiClient.patch<EmailTemplateView>(`${BASE}/${encodeURIComponent(id)}`, input);
}

/** Deactivate (reset) a tenant override — the effective view returns to the
 *  system default. 204 No Content. */
export async function deactivateEmailTemplate(id: string): Promise<void> {
  await apiClient.post<void>(`${BASE}/${encodeURIComponent(id)}/deactivate`);
}

/** Preview SUBMITTED content against the server-owned SAMPLE context. The id names
 *  the template being edited; for a not-yet-created override any placeholder works
 *  (the server ignores it and renders the submitted content). */
export async function previewEmailTemplate(
  id: string,
  input: PreviewEmailTemplateInput,
): Promise<EmailTemplatePreview> {
  return apiClient.post<EmailTemplatePreview>(`${BASE}/${encodeURIComponent(id)}/preview`, input);
}
