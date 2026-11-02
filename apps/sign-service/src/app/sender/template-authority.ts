import type { RoleService } from '@aramo/identity';
import type { SignTemplateEntitlement } from '@aramo/subscription';

// Aramo-TEMPLATE-PRODUCT-1 Implementation Directive v1.0 (LOCKED) §8.1 / §8.5 — what the person
// may do with templates in Aramo Sign, for the sender context (the UI only reflects it; every
// route re-checks server-side, and apps/api re-checks the person's grants again).
//
// The `sign` session carries document_template:read only (consumer-scope-policy), so author /
// approve are read from the person's LIVE role grants in the tenant (RoleService — the canonical
// scope set of their active roles). Nothing here widens a token.

export const TEMPLATE_AUTHOR_SCOPE = 'document_template:author';
export const TEMPLATE_MANAGE_SCOPE = 'document_template:manage';

/** The plan side of templates (Catalog v2 P-6: the Free plan never has templates). */
export type TemplatePlan = 'INCLUDED' | 'FREE_PLAN' | 'SUBSCRIPTION_INACTIVE' | 'NOT_SUBSCRIBED';

export function templatePlanOf(e: SignTemplateEntitlement): TemplatePlan {
  if (e.kind === 'INCLUDED') return 'INCLUDED';
  if (e.kind === 'NOT_SUBSCRIBED') return 'NOT_SUBSCRIBED';
  return e.reason === 'free_plan' ? 'FREE_PLAN' : 'SUBSCRIPTION_INACTIVE';
}

export interface TemplateGrants {
  readonly author: boolean;
  readonly manage: boolean;
}

export async function templateGrantsOf(roles: RoleService | undefined, user_id: string, tenant_id: string): Promise<TemplateGrants> {
  if (roles === undefined) return { author: false, manage: false };
  const held = new Set(await roles.getScopesByUserAndTenant({ user_id, tenant_id }));
  return { author: held.has(TEMPLATE_AUTHOR_SCOPE), manage: held.has(TEMPLATE_MANAGE_SCOPE) };
}

/**
 * §8.2 — the Studio in Aramo Sign is for a PERSONAL account's own templates (the owner holds
 * author + approve); §8.5 — "Use as it is" needs approval (document_template:manage): a Personal
 * owner, or a Business tenant_owner / tenant_admin.
 */
export function templateAuthority(kind: string, grants: TemplateGrants): { studio: boolean; use_as_is: boolean } {
  return { studio: kind === 'PERSONAL' && (grants.author || grants.manage), use_as_is: grants.manage };
}
