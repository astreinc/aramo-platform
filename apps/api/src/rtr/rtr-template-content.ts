// RTR-TEMPLATE-1 (§8, §9, §28) — the versioned RTR template CONTENT CONTRACT.
//
// This is the FIRST production semantics for TemplateVersion.field_schema. It is
// intentionally tiny and explicitly versioned via render_schema_version: the
// resolver (rtr-template-resolver.service) refuses any version string it does not
// recognise (fail closed, never "best effort"), and the binding service
// (rtr-template-binding.service) maps this content + the closed binding catalog
// into the renderer's RenderModel.
//
// It supports only what the current pdf-lib renderer reliably produces today:
// a title plus an ordered list of HEADING / TEXT blocks (RenderBlock in
// @aramo/documents-rendering). No tables / loops / conditionals / HTML — see §8.
//
// The default content below reproduces the CURRENT inline RTR body EXACTLY
// (apps/api/src/rtr/rtr-orchestrator.service.ts, pre-RTR-TEMPLATE-1): one HEADING
// "Right to Represent" and one TEXT line, with the talent name expressed as the
// allowlisted binding token {{talent.full_name}} instead of a TypeScript
// interpolation. This slice is an architecture migration, not a legal-copy
// rewrite (§28): the resolved render output must preserve the current wording.

// The single recognised content-contract version for RTR V1. Unrecognised
// values fail closed in the resolver.
export const RTR_GENERATED_SCHEMA_V1 = 'rtr-generated-v1';

// The CLOSED binding catalog for RTR (§9/§12, INV-9). A content block's text may
// contain ONLY these tokens; the binding service resolves each from an authoritative
// repository server-side (no arbitrary expressions, no open traversal). Extend ONLY
// by adding a descriptor here AND a resolver branch AND a test (§12, §53).
//
// DOC-TEMPLATE-ADMIN-RTR-1 rulings carried from Gate-0:
//   - recruiter.display_name resolves to the SENDING recruiter (§13 preferred; no
//     existing semantics establish the requisition owner as the legal representative).
//   - requisition.reference resolves to requisition_number (REQ-N; external_req_id is
//     nullable and not the authoritative reference).
//   - agreed_pay_rate.* is DELIBERATELY EXCLUDED (§13): no authoritative
//     Talent × Requisition agreed-pay fact exists (confirmed PRODUCT/DATA GAP). It is
//     NOT substituted from desired pay / requisition range / bill rate / offer / placement.
export interface RtrBindingDescriptor {
  readonly key: string; // canonical token
  readonly label: string; // human-readable chip label (Insert field + reading mode)
  readonly group: string; // Insert-field menu group (§15)
  readonly sample: string; // fixed SAFE sample value for admin preview (§17)
}

export const RTR_BINDING_CATALOG: readonly RtrBindingDescriptor[] = [
  { key: 'talent.full_name', label: 'Talent full name', group: 'Talent', sample: 'Ravi Shankar' },
  { key: 'client.name', label: 'Client name', group: 'Client', sample: 'Mindlance' },
  { key: 'requisition.title', label: 'Requisition title', group: 'Requisition', sample: 'Business Analyst - Multi-Family' },
  { key: 'requisition.reference', label: 'Requisition reference', group: 'Requisition', sample: 'REQ-1001' },
  { key: 'recruiting_company.name', label: 'Recruiting organization name', group: 'Recruiting organization', sample: 'Astre Consulting' },
  { key: 'recruiter.display_name', label: 'Recruiter name', group: 'Recruiter', sample: 'Deepika Rao' },
] as const;

export const RTR_BINDING_KEYS = [
  'talent.full_name',
  'client.name',
  'requisition.title',
  'requisition.reference',
  'recruiting_company.name',
  'recruiter.display_name',
] as const;
export type RtrBindingKey = (typeof RTR_BINDING_KEYS)[number];

export function isRtrBindingKey(value: string): value is RtrBindingKey {
  return (RTR_BINDING_KEYS as readonly string[]).includes(value);
}

// Admin preview (§17) — the fixed SAFE sample value for each binding. Keyed lookup
// derived from the single catalog so sample data can never drift from the keys.
export const RTR_BINDING_SAMPLE_VALUES: Readonly<Record<RtrBindingKey, string>> =
  Object.fromEntries(RTR_BINDING_CATALOG.map((d) => [d.key, d.sample])) as Record<RtrBindingKey, string>;

// A content block mirrors the renderer's RenderBlock shape (HEADING | TEXT), but
// its `text` is a TEMPLATE string that may embed {{binding.key}} tokens. The
// binding service substitutes tokens → produces a resolved RenderBlock.
export interface RtrContentBlock {
  type: 'HEADING' | 'TEXT';
  text: string;
}

export interface RtrTemplateContentV1 {
  render_schema_version: typeof RTR_GENERATED_SCHEMA_V1;
  title: string;
  blocks: RtrContentBlock[];
}

// Recruiter-facing default template name (shown as provenance "<name> · v1").
export const DEFAULT_RTR_TEMPLATE_NAME = 'Standard Right to Represent';

// The default tenant RTR template content — byte-faithful to the current inline
// body. {{talent.full_name}} is the sole binding; the surrounding wording is
// unchanged from rtr-orchestrator.service's prior inline model.
export const DEFAULT_RTR_TEMPLATE_CONTENT_V1: RtrTemplateContentV1 = {
  render_schema_version: RTR_GENERATED_SCHEMA_V1,
  title: 'Right to Represent',
  blocks: [
    { type: 'HEADING', text: 'Right to Represent' },
    {
      type: 'TEXT',
      text: 'This authorizes representation of {{talent.full_name}} to the associated client for the associated requisition.',
    },
  ],
};
