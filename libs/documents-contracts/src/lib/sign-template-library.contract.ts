import { createHash } from 'node:crypto';

// DOC-TEMPLATE-LIB-1 T-5 (Implementation Directive v1.0 LOCKED §7; ADR-0034 D12) — the
// wire contract of the Documents template-library endpoints sign-service calls over the
// signed service-to-service channel (scheme aramo-sign-s2s-v1). ONE definition shared by
// the caller (apps/sign-service) and the server (apps/api), so the two sides cannot drift.
//
//   GET  /v1/documents/esign/templates?tenant_id=                 resolved templates
//   POST /v1/documents/esign/templates/:id/preview?tenant_id=&body_sha256=
//   POST /v1/documents/esign/templates/:id/render?tenant_id=&idempotency_key=&body_sha256=
//
// Body binding. The aramo-sign-s2s-v1 signature covers method, exact path, every query
// parameter and the timestamp — not the body. A POST here carries the sender's variable
// values, so its body is bound INDIRECTLY: the caller puts the body's digest in the signed
// query (`body_sha256`) and the server recomputes it over the received body. Changing the
// body breaks the digest; changing the digest breaks the signature. The scheme itself is
// unchanged.

export const SIGN_TEMPLATE_LIBRARY_PATH = '/v1/documents/esign/templates';
export const SIGN_TEMPLATE_BODY_DIGEST_PARAM = 'body_sha256';

// Where a variable's value comes from when the template is used from Aramo Sign.
//   ORGANIZATION — the tenant profile (organization.*, recruiting_company.name) has it.
//   SENDER       — the sender fills it while creating the envelope (Sign has no ATS
//                  context, so every talent / requisition / client / recruiter value is
//                  sender-filled, as is an organization value the profile lacks).
export type SignTemplateVariableSource = 'ORGANIZATION' | 'SENDER';

export interface SignTemplateVariable {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly source: SignTemplateVariableSource;
  // The tenant-profile value for an ORGANIZATION variable; null for SENDER.
  readonly value: string | null;
}

// Amendment M-A6 (LOCKED) §3.2 — a template version's signing roles (rtr-html-v1
// field_schema.signing). SIGNER roles sign (one signature block each); CC roles receive a
// copy (M-A5 recipient kinds). `order` is the signing order (SEQUENTIAL routing).
export type SignTemplateRoleKind = 'SIGNER' | 'CC';
export type SignTemplateRoutingMode = 'PARALLEL' | 'SEQUENTIAL';

export interface SignTemplateRole {
  readonly role_key: string;
  readonly label: string;
  readonly kind: SignTemplateRoleKind;
  readonly order: number;
}

export interface SignTemplateSigning {
  readonly roles: readonly SignTemplateRole[];
  readonly routing_mode: SignTemplateRoutingMode;
  readonly default_subject?: string;
  readonly default_message?: string;
}

export interface SignTemplateSummary {
  readonly template_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly document_type: { readonly id: string; readonly key: string; readonly name: string };
  readonly owner_scope: 'PLATFORM' | 'TENANT';
  // CLIENT_SELECTION | TENANT_SELECTION | PLATFORM_DEFAULT | WITHDRAWAL_FALLBACK — the step
  // of the automatic per-type resolution that selects this template — or AVAILABLE (M-A6
  // §3.1): usable, but not the template the automatic resolution picks.
  readonly resolution: string;
  // M-A6 §3.1 — true for the template the automatic per-type resolution picks (the one ATS
  // and other flows that never ask the user would use).
  readonly is_default: boolean;
  readonly version_id: string;
  readonly version_number: number;
  readonly updated_at: string;
  readonly variables: readonly SignTemplateVariable[];
  // M-A6 §3.7 — list metadata.
  readonly category: string; // = document_type.name
  readonly signer_role_count: number; // 1 for a template without `signing` (the talent block)
  readonly cc_role_count: number;
  readonly document_count: number;
  readonly routing_mode: SignTemplateRoutingMode;
  // The template's roles; null for a template without `signing` (the single talent block).
  readonly signing: SignTemplateSigning | null;
}

export interface SignTemplateListResponse {
  readonly items: readonly SignTemplateSummary[];
  // Document types the tenant cannot start from right now (its selection needs a choice,
  // or the configuration is unusable) — reported, never silently swapped (ADR-0034 D10).
  readonly unavailable: ReadonlyArray<{ readonly document_type_id: string; readonly reason: string }>;
}

export interface SignTemplatePreviewRequest {
  // Sender-entered values (SENDER variables only); missing ones preview with samples.
  readonly values?: Readonly<Record<string, string>>;
}

export interface SignTemplatePreviewResponse {
  readonly template_id: string;
  readonly version_id: string;
  readonly version_number: number;
  readonly title: string;
  readonly blocks: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  readonly html: string | null;
  readonly letterhead: { readonly organization_name: string | null; readonly logo_available: boolean };
  readonly variables: readonly SignTemplateVariable[];
  // M-A6 §3.2 — the version's roles (null without `signing`).
  readonly signing: SignTemplateSigning | null;
}

export interface SignTemplateRenderRequest {
  // Every SENDER variable the template uses, keyed by catalog key.
  readonly values: Readonly<Record<string, string>>;
  // The Sign user creating the envelope (the Document's created_by).
  readonly created_by: string;
  // The client the document is for, when the sender names one (selection precedence).
  readonly client_id?: string | null;
}

// A signature-area placement the renderer drew on the frozen revision (PDF-native frame:
// page_number 0-based, points, origin bottom-left). M-A6 §3.3 — for a template with
// `signing` there is one block per SIGNER role: SIGNATURE, SIGNER_NAME (the printed name
// Sign fills) and SIGN_DATE, each carrying its role_key. Without `signing`: SIGNATURE and
// SIGN_DATE of the single block, no role_key (unchanged).
export interface SignTemplateSignatureField {
  readonly field_type: 'SIGNATURE' | 'SIGNER_NAME' | 'SIGN_DATE';
  readonly page_number: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly role_key?: string;
}

export interface SignTemplateFieldDefinition {
  readonly field_key: string;
  readonly field_type: string;
  readonly signer_role: string | null;
  readonly required: boolean;
  readonly page_number: number | null;
  readonly x: number | null;
  readonly y: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

export interface SignTemplateRenderResponse {
  readonly document_id: string;
  // CORE_REF — the frozen DocumentRevision an envelope document references.
  readonly document_revision_ref: string;
  readonly source_sha256: string;
  readonly byte_size: number;
  readonly title: string;
  readonly template_id: string;
  readonly template_version_id: string;
  readonly version_number: number;
  readonly signature_fields: readonly SignTemplateSignatureField[];
  readonly field_definitions: readonly SignTemplateFieldDefinition[];
  // M-A6 §3.2 — the pinned version's roles (null without `signing`).
  readonly signing: SignTemplateSigning | null;
}

// Deterministic digest of a JSON body: sha256 (hex) over a key-sorted canonical JSON
// form, so the caller and the server agree regardless of key order or whitespace.
export function signTemplateBodyDigest(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}
