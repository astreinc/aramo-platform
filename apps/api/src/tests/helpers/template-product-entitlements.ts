// TEMPLATE-PRODUCT-1 (Directive v1.0 LOCKED §6.3) — test helper: entitle a tenant to the
// template products (the capability keys ats / sign). Since TP-5 the Org Home gallery, the
// default preview, Adopt and the withdrawal notices offer only Aramo defaults whose product
// tags share a capability with the tenant, so a spec that exercises those routes for a
// `core`-only tenant grants the products it means the tenant to have. Raw SQL (the provider
// grant path is the provisioning saga); idempotent on the (tenant_id, capability) key.
export async function grantTemplateProductEntitlements(
  query: (sql: string, params: unknown[]) => Promise<unknown>,
  tenant_id: string,
  products: readonly ('ats' | 'sign')[] = ['ats', 'sign'],
): Promise<void> {
  for (const capability of products) {
    await query(
      `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1::uuid, $2, 'PROVISIONING') ON CONFLICT DO NOTHING`,
      [tenant_id, capability],
    );
  }
}
