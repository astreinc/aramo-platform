// DOC-TEMPLATE-ADMIN-RTR-1 (§14/§17/§36) — the generic template-content capability
// seam. The generic Documents template-admin surface (DocumentTemplatesController) owns
// the ROUTES; the document-type-specific content knowledge (governed binding catalog,
// closed-binding validation, and the fixed-sample preview) is delegated to this port,
// implemented at the composition root (apps/api) per document type. RTR is the only
// configurable type in this increment; every other type is non-configurable (the port
// reports isConfigurable=false and the routes refuse / omit it honestly).
//
// Injected @Optional into the controller: with no provider the generic CRUD still works
// and the capability routes behave as "not configurable". The backend remains
// authoritative — FE hiding is never the boundary (§16).

export const TEMPLATE_CAPABILITIES = 'TEMPLATE_CAPABILITIES';

// One governed binding offered by the Insert-field menu (§15). Canonical token +
// human-readable label + grouping. NEVER a raw database path.
export interface TemplateBindingDescriptor {
  readonly key: string;
  readonly label: string;
  readonly group: string;
}

// A fixed-sample preview (§17): the version's content with every binding substituted by
// its SAFE sample value. Structured resolved blocks — the exact shape the renderer
// consumes — so the preview is faithful to production output without creating any
// business Document / association / requirement / envelope (§17/§39).
export interface TemplateSamplePreview {
  readonly title: string;
  readonly blocks: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  // B2 — the fixed signature block the renderer appends after the content (not template
  // content). printed_name = the sample talent name in an admin preview; null when the
  // document type has no signature block.
  readonly signature_block?: { readonly printed_name: string | null };
  // A1 (rtr-html-v1) / editor v2 — the fixed sample value of every catalog binding (both
  // content versions), so the FE can show exactly what the preview substituted.
  readonly sample_values?: ReadonlyArray<{ readonly key: string; readonly label: string; readonly value: string }>;
  // rtr-html-v1 only — the content with each field node replaced by
  // <span data-sample="{key}">{escaped sample}</span>, and the version's frozen logo.
  readonly html?: string;
  readonly logo?: { readonly asset_id: string } | null;
}

// The server-owned logo reference stored with a version's content (A1 §2.4).
export interface TemplateLogoRef {
  readonly asset_id: string;
  readonly sha256: string;
  readonly mime: 'image/png' | 'image/jpeg';
}

export interface TemplateCapabilitiesPort {
  // Is this document type tenant-template configurable in this increment? (RTR: true.)
  isConfigurable(documentTypeId: string): boolean;

  // The governed binding catalog for a document type (the Insert-field source, §15). The
  // SAME canonical catalog the backend validates against — the FE fetches this, so there
  // is no FE mirror to drift (§14). Empty for non-configurable types.
  // DOC-TEMPLATE-LIB-1 T-2 (§2 F-7, ADR-0034 D7) — read from the Aramo-maintained
  // TemplateVariable catalog (active rows), hence async.
  listAllowedBindings(documentTypeId: string): Promise<readonly TemplateBindingDescriptor[]>;

  // Closed-binding validation (§14): the draft content must be structurally valid for the
  // type and reference ONLY catalog bindings. Throws (TemplateBindingUnsupportedError /
  // VALIDATION_ERROR) on an unknown token, structural invalidity, or empty content. A
  // non-configurable type is a no-op (nothing to validate). Authoritative at activation.
  validateDraftContent(input: { document_type_id: string; field_schema: unknown; render_schema_version: string; requestId: string }): Promise<void>;

  // Fixed-sample preview (§17) of the CURRENT draft content. Validates first, then
  // substitutes the fixed SAFE sample values. Never persists a business Document.
  // DOC-TEMPLATE-LIB-1 T-4 (§8.2, ADR-0034 D8) — `sample_overrides`: catalog keys whose
  // preview value is the tenant's own (the organization.* branding values) instead of the
  // fixed sample; keys outside the allowed catalog are ignored.
  renderSamplePreview(input: {
    document_type_id: string;
    field_schema: unknown;
    render_schema_version: string;
    requestId: string;
    sample_overrides?: Readonly<Record<string, string>>;
  }): Promise<TemplateSamplePreview>;

  // A1 §2.2 — authoritative PATCH-time normalisation of DRAFT content. For a sanitised
  // content version (rtr-html-v1) the html is re-serialised against the allowlist and
  // server-owned keys (the logo reference) are carried over from the EXISTING content,
  // never taken from the client. Throws VALIDATION_ERROR (422, details.reason) on an
  // unknown field / logo position / size violation. Other versions pass through unchanged.
  normalizeDraftContent(input: {
    document_type_id: string;
    render_schema_version: string;
    field_schema: unknown;
    existing_field_schema: unknown;
    requestId: string;
  }): Promise<unknown>;

  // A1 §2.1 — the content a NEW DRAFT starts from, given the ACTIVE version's content
  // (rtr-generated-v1 is converted to rtr-html-v1; html content is copied as-is, logo
  // reference included).
  draftContentFrom(input: { document_type_id: string; render_schema_version: string; field_schema: unknown }): {
    render_schema_version: string;
    field_schema: unknown;
  };

  // A1 §2.4 — the logo reference carried by stored content (null when none / not html).
  logoOf(field_schema: unknown): TemplateLogoRef | null;

  // A1 §2.4 — content with the logo reference attached (html: also ensures the single
  // logo node is the FIRST child) / detached (removes the reference AND the logo node).
  withLogo(field_schema: unknown, logo: TemplateLogoRef | null, requestId: string): unknown;
}

// A1 §2.4 — the tenant-profile logo seam (bound at the composition root, apps/api): reads
// Tenant.logo_url, fetches it ONCE at the admin capture action (https only, timeout,
// size cap, PNG/JPEG magic bytes), stores the bytes in the documents object storage, and
// reads frozen bytes back. libs/documents never imports identity or object storage.
export const TEMPLATE_TENANT_LOGO = 'TEMPLATE_TENANT_LOGO';

export interface TenantLogoInfo {
  readonly available: boolean;
  readonly tenant_name: string | null;
}

export interface CapturedTenantLogo {
  readonly sha256: string;
  readonly mime: 'image/png' | 'image/jpeg';
  readonly storage_provider: string;
  readonly storage_locator: string;
  readonly byte_size: number;
}

export interface TemplateTenantLogoPort {
  info(tenant_id: string): Promise<TenantLogoInfo>;
  // Throws AramoError: 409 VALIDATION_ERROR reason=no_tenant_logo when the profile has no
  // logo; 422 VALIDATION_ERROR reason=logo_* on an unusable logo (scheme/size/type/fetch).
  capture(input: { tenant_id: string; requestId: string }): Promise<CapturedTenantLogo>;
  read(input: { storage_locator: string; requestId: string }): Promise<Buffer>;
}

// DOC-TEMPLATE-LIB-1 T-4 (§8.2, ADR-0034 D8) — the tenant branding seam for the Org Home
// gallery preview of an Aramo default (bound at the composition root, apps/api, from the
// tenant profile). Read-only: no logo capture, no asset, no Document. `values` holds the
// organization.* catalog keys the tenant has on record (non-empty only).
export const TEMPLATE_TENANT_BRANDING = 'TEMPLATE_TENANT_BRANDING';

export interface TenantBrandingView {
  readonly organization_name: string | null;
  readonly logo_available: boolean;
  readonly values: Readonly<Record<string, string>>;
}

export interface TemplateTenantBrandingPort {
  forTenant(tenant_id: string): Promise<TenantBrandingView>;
}
