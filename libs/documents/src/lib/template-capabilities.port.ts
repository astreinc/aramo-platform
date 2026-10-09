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
}

export interface TemplateCapabilitiesPort {
  // Is this document type tenant-template configurable in this increment? (RTR: true.)
  isConfigurable(documentTypeId: string): boolean;

  // The governed binding catalog for a document type (the Insert-field source, §15). The
  // SAME canonical catalog the backend validates against — the FE fetches this, so there
  // is no FE mirror to drift (§14). Empty for non-configurable types.
  listAllowedBindings(documentTypeId: string): readonly TemplateBindingDescriptor[];

  // Closed-binding validation (§14): the draft content must be structurally valid for the
  // type and reference ONLY catalog bindings. Throws (TemplateBindingUnsupportedError /
  // VALIDATION_ERROR) on an unknown token, structural invalidity, or empty content. A
  // non-configurable type is a no-op (nothing to validate). Authoritative at activation.
  validateDraftContent(input: { document_type_id: string; field_schema: unknown; render_schema_version: string; requestId: string }): void;

  // Fixed-sample preview (§17) of the CURRENT draft content. Validates first, then
  // substitutes the fixed SAFE sample values. Never persists a business Document.
  renderSamplePreview(input: { document_type_id: string; field_schema: unknown; render_schema_version: string; requestId: string }): TemplateSamplePreview;
}
