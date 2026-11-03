// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7.3 — the tenant client for Aramo
// fixed legal forms (Org Home "Our templates": "Aramo form · read-only", preview, Hide / Show).
// Thin surface over /v1/document-templates/library/fixed-forms*; the server decides which forms
// the tenant may see (published, tagged with a product the tenant is entitled to). Hide / Show
// needs document_template:manage (server-enforced).

import { apiClient } from '@aramo/fe-foundation';

import { type FixedFormField, type FixedFormPage, type FixedFormSigning } from './fixed-form-model';

const BASE = '/v1/document-templates/library/fixed-forms';

export interface TenantFixedForm {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly document_type: { readonly id: string; readonly key: string; readonly name: string; readonly category: string | null };
  readonly products: readonly string[];
  readonly version_id: string;
  readonly version_number: number;
  readonly updated_at: string;
  readonly withdraw_effective_at: string | null;
  readonly page_count: number;
  readonly hidden: boolean;
}

export interface TenantFixedFormDetail extends TenantFixedForm {
  readonly title: string;
  readonly pages: readonly FixedFormPage[];
  readonly signing: FixedFormSigning;
  readonly fields: readonly FixedFormField[];
  readonly variables: ReadonlyArray<{ readonly key: string; readonly label: string }>;
}

function isFixedFormItem(x: unknown): x is TenantFixedForm {
  const o = x as Partial<TenantFixedForm> | null;
  return o !== null && typeof o === 'object' && typeof o.id === 'string' && typeof o.hidden === 'boolean' && typeof o.version_number === 'number' && Array.isArray(o.products);
}

export async function listFixedForms(): Promise<readonly TenantFixedForm[]> {
  const out = await apiClient.get<{ items?: unknown }>(BASE);
  // Only well-formed form rows (a stray or older response never renders as a form).
  return Array.isArray(out?.items) ? (out.items as unknown[]).filter(isFixedFormItem) : [];
}

export async function getFixedForm(id: string): Promise<TenantFixedFormDetail> {
  return apiClient.get<TenantFixedFormDetail>(`${BASE}/${encodeURIComponent(id)}`);
}

export async function getFixedFormPdf(id: string): Promise<{ sha256: string; byte_size: number; content_base64: string }> {
  return apiClient.get(`${BASE}/${encodeURIComponent(id)}/pdf`);
}

export async function setFixedFormHidden(id: string, hidden: boolean): Promise<TenantFixedForm> {
  return apiClient.post<TenantFixedForm>(`${BASE}/${encodeURIComponent(id)}/${hidden ? 'hide' : 'show'}`);
}
