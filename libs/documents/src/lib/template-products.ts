import type { Capability } from '@aramo/entitlement';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §2.1 — template product tags
// are the entitlement capability keys (libs/entitlement CAPABILITY_VALUES / Prisma enum
// Capability). A template may be tagged with the products that use templates: ats and
// sign. Display labels (ATS / Sign) live in libs/document-templates-web; the stored value
// is always the key. Typed against Capability, so a key that is not a capability fails to
// compile.
export const TEMPLATE_PRODUCT_KEYS = ['ats', 'sign'] as const satisfies readonly Capability[];
export type TemplateProductKey = (typeof TEMPLATE_PRODUCT_KEYS)[number];

export function isTemplateProductKey(value: unknown): value is TemplateProductKey {
  return typeof value === 'string' && (TEMPLATE_PRODUCT_KEYS as readonly string[]).includes(value);
}

/**
 * TEMPLATE-PRODUCT-1 §6.3 — the template product keys among a tenant's entitlement
 * capabilities (E ∩ {ats, sign}).
 */
export function entitledTemplateProducts(capabilities: ReadonlySet<string>): TemplateProductKey[] {
  return TEMPLATE_PRODUCT_KEYS.filter((k) => capabilities.has(k));
}

/** §6.3 — a template is offered to a tenant iff its products ∩ E ≠ ∅ (case-insensitive). */
export function visibleToTenant(products: readonly string[] | null | undefined, entitled: readonly string[]): boolean {
  return (products ?? []).some((p) => entitled.includes(p.toLowerCase()));
}
