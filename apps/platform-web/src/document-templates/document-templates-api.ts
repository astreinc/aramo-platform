import { apiClient } from '@aramo/fe-foundation';

// DOC-TEMPLATE-LIB-1 T-2 (§8.1) — typed client for the platform-tier Aramo default
// templates (/platform/document-templates*) and the template variable catalog
// (/platform/template-variables*). Edge-routed to apps/api (vite.config / nginx). Rides
// the shared HttpOnly platform session cookie via apiClient. Server-side scope +
// consumer_type checks are authoritative; the UI only hides controls.

export const DOC_TEMPLATE_READ_SCOPE = 'platform:document_template:read';
export const DOC_TEMPLATE_MANAGE_SCOPE = 'platform:document_template:manage';

// The editable content contract (rtr-html-v1 — the A1 allowlisted html).
export const HTML_CONTENT_VERSION = 'rtr-html-v1';

export interface PlatformTemplateVersionSummary {
  id: string;
  version_number: number;
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  activated_at: string | null;
}

export interface PlatformTemplate {
  id: string;
  owner_scope: 'PLATFORM';
  document_type_id: string;
  name: string;
  description: string | null;
  template_kind: string;
  status: string;
  products: string[];
  current_version: PlatformTemplateVersionSummary | null;
  draft_version_id: string | null;
  withdraw_notice_at: string | null;
  withdraw_effective_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TemplateVersion {
  id: string;
  template_id: string;
  version_number: number;
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  render_schema_version: string;
  field_schema: unknown;
  activated_at: string | null;
  created_at: string;
  content_fingerprint: string | null;
  previewed_fingerprint: string | null;
  internal_notes: string | null;
}

export interface PlatformTemplateDetail extends PlatformTemplate {
  versions: TemplateVersion[];
}

export interface DocumentTypeOption {
  id: string;
  key: string;
  name: string;
  configurable: boolean;
}

export interface AllowedBinding {
  key: string;
  label: string;
  group: string;
}

export interface SamplePreview {
  title: string;
  blocks: ReadonlyArray<{ type: string; text: string }>;
  html?: string;
  sample_values?: ReadonlyArray<{ key: string; label: string; value: string }>;
}

export interface TemplateVariable {
  id: string;
  key: string;
  label: string;
  group_label: string;
  data_type: TemplateVariableDataType;
  products: string[];
  ats_binding_key: string | null;
  sample_value: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export const TEMPLATE_VARIABLE_DATA_TYPES = ['TEXT', 'MULTILINE_TEXT', 'DATE', 'NUMBER', 'CURRENCY'] as const;
export type TemplateVariableDataType = (typeof TEMPLATE_VARIABLE_DATA_TYPES)[number];

export interface HtmlContent {
  render_schema_version: typeof HTML_CONTENT_VERSION;
  title: string;
  html: string;
}

// Read the editable html content of a version (null when it is another content version).
export function htmlContentOf(v: Pick<TemplateVersion, 'render_schema_version' | 'field_schema'>): HtmlContent | null {
  if (v.render_schema_version !== HTML_CONTENT_VERSION) return null;
  const fs = v.field_schema as { title?: unknown; html?: unknown } | null;
  if (fs === null || typeof fs !== 'object' || typeof fs.title !== 'string' || typeof fs.html !== 'string') return null;
  return { render_schema_version: HTML_CONTENT_VERSION, title: fs.title, html: fs.html };
}

// Parse the comma/space separated product tag input into upper-case tags.
export function parseProductTags(raw: string): string[] {
  const out: string[] = [];
  for (const t of raw.split(/[\s,]+/)) {
    const tag = t.trim().toUpperCase();
    if (tag.length > 0 && !out.includes(tag)) out.push(tag);
  }
  return out;
}

// DOC-TEMPLATE-LIB-1 T-6 (§9) — the default notice length for a withdrawal (days).
export const DEFAULT_WITHDRAW_NOTICE_DAYS = 7;
export const MAX_WITHDRAW_NOTICE_DAYS = 365;

export type WithdrawalState = 'NONE' | 'PENDING' | 'IN_EFFECT';

// The withdrawal state of a default at `now` (the server is authoritative; display only).
export function withdrawalStateOf(
  t: Pick<PlatformTemplate, 'withdraw_effective_at'>,
  now: Date = new Date(),
): WithdrawalState {
  if (t.withdraw_effective_at === null) return 'NONE';
  return new Date(t.withdraw_effective_at).getTime() <= now.getTime() ? 'IN_EFFECT' : 'PENDING';
}

export const documentTemplatesApi = {
  listDocumentTypes(): Promise<{ document_types: DocumentTypeOption[] }> {
    return apiClient.get('/platform/document-templates/document-types');
  },
  listTemplates(): Promise<{ templates: PlatformTemplate[] }> {
    return apiClient.get('/platform/document-templates');
  },
  getTemplate(id: string): Promise<PlatformTemplateDetail> {
    return apiClient.get(`/platform/document-templates/${id}`);
  },
  createTemplate(body: {
    document_type_id: string;
    name: string;
    description: string | null;
    template_kind: string;
    products: string[];
  }): Promise<PlatformTemplate> {
    return apiClient.post('/platform/document-templates', body);
  },
  updateTemplate(id: string, body: { name?: string; description?: string | null; products?: string[] }): Promise<PlatformTemplate> {
    return apiClient.patch(`/platform/document-templates/${id}`, body);
  },
  // DOC-TEMPLATE-LIB-1 T-6 (§9) — publish / cancel a withdrawal of an Aramo default.
  withdraw(id: string, body: { notice_days: number; reason: string | null }): Promise<PlatformTemplate> {
    return apiClient.post(`/platform/document-templates/${id}/withdraw`, body);
  },
  cancelWithdrawal(id: string): Promise<PlatformTemplate> {
    return apiClient.post(`/platform/document-templates/${id}/withdraw/cancel`);
  },
  allowedBindings(id: string): Promise<{ bindings: AllowedBinding[] }> {
    return apiClient.get(`/platform/document-templates/${id}/allowed-bindings`);
  },
  createDraft(id: string, body?: { render_schema_version: string; field_schema: unknown }): Promise<TemplateVersion> {
    return apiClient.post(`/platform/document-templates/${id}/versions`, body ?? {});
  },
  // PLATFORM-UX-1 F-9 (directive R-10) — read one version (the "Start from a copy" source).
  getVersion(versionId: string): Promise<TemplateVersion> {
    return apiClient.get(`/platform/document-templates/versions/${versionId}`);
  },
  updateDraft(versionId: string, body: { field_schema?: unknown; render_schema_version?: string; internal_notes?: string | null }): Promise<TemplateVersion> {
    return apiClient.patch(`/platform/document-templates/versions/${versionId}`, body);
  },
  preview(versionId: string): Promise<SamplePreview> {
    return apiClient.post(`/platform/document-templates/versions/${versionId}/preview`);
  },
  publish(versionId: string): Promise<TemplateVersion> {
    return apiClient.post(`/platform/document-templates/versions/${versionId}/publish`);
  },
  listVariables(): Promise<{ variables: TemplateVariable[] }> {
    return apiClient.get('/platform/template-variables');
  },
  createVariable(body: {
    key: string;
    label: string;
    group_label: string;
    data_type: TemplateVariableDataType;
    products: string[];
    ats_binding_key: string | null;
    sample_value: string | null;
    active: boolean;
  }): Promise<TemplateVariable> {
    return apiClient.post('/platform/template-variables', body);
  },
  updateVariable(
    id: string,
    body: Partial<Pick<TemplateVariable, 'label' | 'group_label' | 'data_type' | 'products' | 'ats_binding_key' | 'sample_value' | 'active'>>,
  ): Promise<TemplateVariable> {
    return apiClient.patch(`/platform/template-variables/${id}`, body);
  },
};
