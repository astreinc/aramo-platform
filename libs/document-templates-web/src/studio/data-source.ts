import type { ReactNode } from 'react';

import { RTR_HTML_SCHEMA_V1 } from '../document-templates-api';
import { studioBlocksFromHtml, studioBlocksToHtml, studioDocFromHtml, studioDocToHtml, isStudioLetterheadBlock, type StudioBlock, type StudioLetterheadBlock } from '../studio-codec';

import type { PillSpec } from './primitives';
import type { Readiness } from './readiness';

// TEMPLATE-STUDIO-1 S-0 (directive §2) — the Template Studio's data-source adapter. The
// ONE shared Studio (libs/document-templates-web) renders for Platform Admin and for
// Organization; everything context-specific comes through this interface:
//   • the reads and writes (each host wraps its own API client):
//       platform      /platform/document-templates*      (apps/platform-web)
//       organization  /v1/document-templates*            (S-1)
//         load      = GET /:id  +  GET /:id/versions
//         catalog   = the variable catalog + GET /:id/allowed-bindings
//         createDraft = POST /:id/versions | POST /:id/draft
//         saveDraft = PATCH /versions/:id
//         discardDraft = DELETE /versions/:id
//         preview   = POST /versions/:id/preview
//         approve   = POST /versions/:id/activate (platform: …/publish)
//   • the caller's capabilities (read-only · edit · edit-and-approve; withdrawal, tags);
//   • the copy that differs (Publish vs Approve & activate, crumbs, consequence text);
//   • optionally the content codec (the tenant letterhead block, A1).
// The server stays authoritative for every rule; capabilities only hide controls.

/** The editable content contract (rtr-html-v1). */
export const STUDIO_HTML_CONTENT_VERSION = RTR_HTML_SCHEMA_V1;

export type StudioVersionStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';

/** One version of a template, as the Studio reads it. */
export interface StudioVersion {
  readonly id: string;
  readonly version_number: number;
  readonly status: StudioVersionStatus;
  readonly render_schema_version: string;
  readonly field_schema: unknown;
  readonly activated_at: string | null;
  readonly created_at: string;
  readonly content_fingerprint: string | null;
  readonly previewed_fingerprint: string | null;
  /**
   * TEMPLATE-STUDIO-1 S-1 — the version's server-owned letterhead logo reference (A1;
   * organization only). Absent on the platform.
   */
  readonly logo?: { readonly asset_id: string; readonly mime?: string } | null;
}

/** The template's own fields (no versions). */
export interface StudioTemplateInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** 'ACTIVE' once a version is live. */
  readonly status: string;
  readonly document_type_id: string;
  /** Product tags (platform only; tenants carry none). */
  readonly products: readonly string[];
  readonly current_version: { readonly id: string; readonly version_number: number } | null;
  /** A published withdrawal's effective time (platform only; null otherwise). */
  readonly withdraw_effective_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** The template plus every version (load). */
export interface StudioTemplate extends StudioTemplateInfo {
  readonly versions: readonly StudioVersion[];
}

/** A catalog variable (GET …/template-variables or the tenant catalog). */
export interface StudioCatalogVariable {
  readonly key: string;
  readonly label: string;
  readonly group_label: string;
  readonly data_type: string;
  readonly sample_value: string | null;
  readonly active: boolean;
}

/** A key this template's document type can bind (GET …/:id/allowed-bindings). */
export interface StudioAllowedBinding {
  readonly key: string;
  readonly label: string;
  readonly group: string;
}

export interface StudioCatalogData {
  readonly variables: readonly StudioCatalogVariable[];
  readonly bindings: readonly StudioAllowedBinding[];
  /** Document type names (the Properties "Document type" fact). */
  readonly documentTypes?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** TEMPLATE-STUDIO-1 S-1 — whether the organization profile has a logo to capture (A1). */
  readonly tenantLogo?: { readonly available: boolean; readonly tenant_name: string } | null;
}

/** The server's sample render of a draft (POST …/versions/:id/preview). */
export interface StudioSamplePreview {
  readonly title: string;
  readonly html?: string;
  readonly sample_values?: ReadonlyArray<{ readonly key: string; readonly label: string; readonly value: string }>;
  /** TEMPLATE-STUDIO-1 S-1 — the letterhead logo the render carries (organization only). */
  readonly logo?: { readonly asset_id: string } | null;
  /** TEMPLATE-STUDIO-1 S-2 — the page-header organization line, when the server names it. */
  readonly org?: string;
}

/**
 * Amendment M-A6 (LOCKED) §3.2 — a template's signing roles (rtr-html-v1
 * `field_schema.signing`). SIGNER roles sign (one signature block each in Aramo Sign); CC
 * roles receive a copy. Frozen and fingerprinted with the version; the server validates.
 */
export type StudioSigningRoleKind = 'SIGNER' | 'CC';
export type StudioRoutingMode = 'PARALLEL' | 'SEQUENTIAL';
export interface StudioSigningRole {
  readonly role_key: string;
  readonly label: string;
  readonly kind: StudioSigningRoleKind;
  readonly order: number;
}
export interface StudioSigning {
  readonly roles: readonly StudioSigningRole[];
  readonly routing_mode: StudioRoutingMode;
  readonly default_subject?: string;
  readonly default_message?: string;
}

/** The body of a draft create / save. */
export interface StudioContentBody {
  readonly render_schema_version: string;
  readonly field_schema: {
    readonly render_schema_version: string;
    readonly title: string;
    readonly html: string;
    /**
     * M-A6 §3.2 — sent only when the Studio changed the roles: an object sets them, null
     * removes them. Omitted ⇒ the server keeps the draft's roles, so a body without it is
     * byte-identical to before (PLATFORM-UX-1 R-11).
     */
    readonly signing?: StudioSigning | null;
  };
}

export interface StudioPropertiesPatch {
  readonly name?: string;
  readonly description?: string | null;
  readonly products?: string[];
}

export interface StudioCapabilities {
  /** Edit the draft (save, preview, restore). False = read-only (published version, Preview only). */
  readonly canEdit: boolean;
  /** Approve the draft (platform: Publish vN; organization: Approve & activate vN). */
  readonly canApprove: boolean;
  /** Withdraw / cancel a withdrawal (needs `withdraw` / `cancelWithdrawal`). */
  readonly canWithdraw: boolean;
  /** Show the product-tags property. */
  readonly productTags: boolean;
  /** Show the description property. */
  readonly description: boolean;
  /**
   * TEMPLATE-STUDIO-1 S-2 — show the Versions tab and Compare (default true). The tenant
   * read-only preview of an Aramo default hides them (ADR-0034 D3: current version only).
   */
  readonly versions?: boolean;
  /**
   * TEMPLATE-STUDIO-1 (acceptance §11 item 3) — show the Edit | Preview mode toggle
   * (default true). The tenant read-only preview of an Aramo default can never be edited,
   * so it hides the toggle; a read-only view of an editable template keeps it.
   */
  readonly modeToggle?: boolean;
  /**
   * TEMPLATE-STUDIO-1 (acceptance §11 item 3) — show the publishing checks: the readiness
   * pill and the Checks tab (default true). Hidden in the tenant read-only preview of an
   * Aramo default, where there is no draft to approve.
   */
  readonly checks?: boolean;
  /**
   * TEMPLATE-STUDIO-1 (scope ruling 2026-10-27 item 2) — show the "N× in draft" usage
   * counts on the Variables cards (default true). Hidden in the tenant read-only preview
   * of an Aramo default: there is no draft, so the count is meaningless there.
   */
  readonly usageCounts?: boolean;
}

/** The content codec: stored html ↔ the editable blocks (+ the tenant letterhead, A1). */
export interface StudioContentCodec {
  decode(html: string, newId: () => string): { blocks: StudioBlock[]; letterhead: StudioLetterheadBlock | null };
  encode(blocks: readonly StudioBlock[], letterhead: StudioLetterheadBlock | null): string;
}

/** The platform codec: content blocks only (studioBlocksFromHtml / studioBlocksToHtml). */
export const DEFAULT_STUDIO_CONTENT_CODEC: StudioContentCodec = {
  decode: (html, newId) => ({ blocks: studioBlocksFromHtml(html, newId), letterhead: null }),
  encode: (blocks) => studioBlocksToHtml(blocks),
};

/**
 * The letterhead-preserving codec (TEMPLATE-STUDIO-1 B-1, A1): the first-child
 * `data-asset="tenant.logo"` node is carried through every save as the letterhead block
 * (studioDocFromHtml / studioDocToHtml). Content without a logo encodes exactly as the
 * default codec does.
 */
export const LETTERHEAD_STUDIO_CONTENT_CODEC: StudioContentCodec = {
  decode: (html, newId) => {
    const doc = studioDocFromHtml(html, newId);
    const head = doc.find((b): b is StudioLetterheadBlock => isStudioLetterheadBlock(b)) ?? null;
    return { blocks: doc.filter((b): b is StudioBlock => !isStudioLetterheadBlock(b)), letterhead: head };
  },
  encode: (blocks, letterhead) => studioDocToHtml(letterhead !== null ? [letterhead, ...blocks] : blocks),
};

/**
 * TEMPLATE-STUDIO-1 S-1 (directive §7.2) — a static section of the Sections tab: content
 * built only from existing catalog variables. Insert adds its blocks to the draft.
 */
export interface StudioSection {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** Stored rtr-html-v1 html of the section's blocks. */
  readonly html: string;
}

/**
 * TEMPLATE-STUDIO-1 S-1 (A1) — the tenant letterhead logo: captured from the organization
 * profile onto the DRAFT (POST …/versions/:id/logo) and removed only through
 * DELETE …/versions/:id/logo (the server places / strips the node). Organization only.
 */
export interface StudioLetterheadApi {
  capture(versionId: string): Promise<unknown>;
  remove(versionId: string): Promise<void>;
  /** The logo image of a version (GET …/versions/:id/logo/content). */
  logoUrl(versionId: string, assetId: string | null): string;
}

export interface StudioCrumb {
  readonly label: string;
  /** A link (the last linked crumb is also the narrow-width "←" target). */
  readonly to?: string;
}

/** The copy that differs between contexts. */
export interface TemplateStudioCopy {
  /** The breadcrumb before the template name. */
  readonly crumbs: readonly StudioCrumb[];
  /** The narrow-width back link ("←"). */
  readonly back: { readonly to: string; readonly label: string };
  /** The top-bar approve button ("Publish v4…"; `wide` = ≥1200px). */
  readonly approveButton: (next: number, wide: boolean) => ReactNode;
  /** Its title while checks fail. */
  readonly approveHint: string;
  /** The readiness pill label (wide = ≥1200px). */
  readonly readinessLabel: (r: Readiness, wide: boolean) => string;
  /** The Checks tab footnote. */
  readonly checksNote: string;
  /** The approve dialog. */
  readonly approveDialog: {
    readonly title: (next: number, name: string) => string;
    readonly commit: (next: number) => string;
    readonly from: (current: number | null) => PillSpec;
    readonly to: (next: number) => PillSpec;
    readonly consequence: (next: number, current: number | null) => string;
  };
  readonly approveToast: (versionNumber: number) => string;
  readonly approveFailed: string;
  /** The version pills (current / earlier). */
  readonly versionActive: PillSpec;
  readonly versionRetired: PillSpec;
  /** The read-only bar under the header. */
  readonly viewOnly: ReactNode;
  /** The Variables tab's catalog link (omit to hide it). */
  readonly manageVariables?: { readonly to: string; readonly label: string };
  // ── TEMPLATE-STUDIO-1 S-1 (organization) — optional; the platform keeps its built-in copy.
  /** The Variables tab footnote. */
  readonly variablesNote?: string;
  /** The Properties tab's Scope card. */
  readonly scopeCard?: ReactNode;
  /** The publish dialog's inactive-variable warning ("…will be approved as is"). */
  readonly approveWarnings?: (n: number) => string;
  /** The toast after "Restore into draft". */
  readonly restoreToast?: (n: number) => string;
  /** The Checks detail of an unknown variable. */
  readonly unknownVariableDetail?: string;
}

export interface TemplateStudioDataSource {
  load(templateId: string): Promise<StudioTemplate>;
  catalog(templateId: string): Promise<StudioCatalogData>;
  createDraft(templateId: string, body: StudioContentBody): Promise<StudioVersion>;
  saveDraft(versionId: string, body: StudioContentBody): Promise<StudioVersion>;
  /** Discard the open draft (organization). */
  discardDraft?(versionId: string): Promise<void>;
  preview(versionId: string): Promise<StudioSamplePreview>;
  /** Platform: publish · organization: activate. */
  approve(versionId: string): Promise<StudioVersion>;
  updateProperties?(templateId: string, patch: StudioPropertiesPatch): Promise<StudioTemplateInfo>;
  withdraw?(templateId: string, body: { notice_days: number; reason: string | null }): Promise<StudioTemplateInfo>;
  cancelWithdrawal?(templateId: string): Promise<unknown>;
  /**
   * TEMPLATE-STUDIO-1 S-2 — the read-only Preview's server render of the CURRENT version
   * (the tenant's branded preview of an Aramo default). Without it a read-only viewer sees
   * the current version's stored content.
   */
  previewCurrent?(templateId: string): Promise<StudioSamplePreview>;
  /** TEMPLATE-STUDIO-1 S-1 — the tenant letterhead logo (organization only). */
  readonly letterhead?: StudioLetterheadApi;
  /** TEMPLATE-STUDIO-1 S-1 — the Sections tab's static set (omit: the empty state, R-13). */
  readonly sections?: readonly StudioSection[];
  readonly capabilities: StudioCapabilities;
  readonly copy: TemplateStudioCopy;
  /** Default: DEFAULT_STUDIO_CONTENT_CODEC. */
  readonly content?: StudioContentCodec;
}

export type TemplateStudioContext = 'platform' | 'organization';

// ── withdrawal (platform defaults, DOC-TEMPLATE-LIB-1 T-6 §9) ─────────────────

export const DEFAULT_WITHDRAW_NOTICE_DAYS = 7;
export const MAX_WITHDRAW_NOTICE_DAYS = 365;

export type WithdrawalState = 'NONE' | 'PENDING' | 'IN_EFFECT';

/** The withdrawal state of a template at `now` (display only; the server is authoritative). */
export function withdrawalStateOf(t: Pick<StudioTemplateInfo, 'withdraw_effective_at'>, now: Date = new Date()): WithdrawalState {
  if (t.withdraw_effective_at === null) return 'NONE';
  return new Date(t.withdraw_effective_at).getTime() <= now.getTime() ? 'IN_EFFECT' : 'PENDING';
}

/** M-A6 §3.2 — the signing roles stored in a field_schema (null when absent or malformed). */
export function studioSigningOf(field_schema: unknown): StudioSigning | null {
  const sg = (field_schema as { signing?: unknown } | null)?.signing;
  if (sg === null || typeof sg !== 'object' || Array.isArray(sg)) return null;
  const o = sg as { roles?: unknown; routing_mode?: unknown; default_subject?: unknown; default_message?: unknown };
  if (!Array.isArray(o.roles) || (o.routing_mode !== 'PARALLEL' && o.routing_mode !== 'SEQUENTIAL')) return null;
  const roles: StudioSigningRole[] = [];
  for (const r of o.roles as Array<Record<string, unknown>>) {
    if (r === null || typeof r !== 'object') return null;
    if (typeof r['role_key'] !== 'string' || typeof r['label'] !== 'string' || typeof r['order'] !== 'number') return null;
    if (r['kind'] !== 'SIGNER' && r['kind'] !== 'CC') return null;
    roles.push({ role_key: r['role_key'], label: r['label'], kind: r['kind'], order: r['order'] });
  }
  return {
    roles: roles.sort((a, b) => a.order - b.order),
    routing_mode: o.routing_mode,
    ...(typeof o.default_subject === 'string' ? { default_subject: o.default_subject } : {}),
    ...(typeof o.default_message === 'string' ? { default_message: o.default_message } : {}),
  };
}

/** The editable html content of a version (null when it is another content version). */
export function studioHtmlContentOf(v: Pick<StudioVersion, 'render_schema_version' | 'field_schema'>): { title: string; html: string } | null {
  if (v.render_schema_version !== STUDIO_HTML_CONTENT_VERSION) return null;
  const fs = v.field_schema as { title?: unknown; html?: unknown } | null;
  if (fs === null || typeof fs !== 'object' || typeof fs.title !== 'string' || typeof fs.html !== 'string') return null;
  return { title: fs.title, html: fs.html };
}
