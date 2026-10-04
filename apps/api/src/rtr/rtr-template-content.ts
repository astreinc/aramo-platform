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

// The CLOSED binding catalog for RTR V1 (§9, INV-9). A content block's text may
// contain ONLY these tokens; the binding service resolves each from an
// authoritative repository server-side. No arbitrary expressions, no open
// traversal. V1 needs exactly one binding — the talent's full name, the only
// dynamic value in the current RTR body. Extend ONLY by adding a key here AND a
// resolver branch AND a test (§9, §33).
export const RTR_BINDING_KEYS = ['talent.full_name'] as const;
export type RtrBindingKey = (typeof RTR_BINDING_KEYS)[number];

export function isRtrBindingKey(value: string): value is RtrBindingKey {
  return (RTR_BINDING_KEYS as readonly string[]).includes(value);
}

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
