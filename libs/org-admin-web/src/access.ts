import { fetchMyProducts, orgAccessOf, useMyProducts, type ProductAvailabilityView, type Session } from '@aramo/fe-foundation';

import type { OrgAccessTier } from './sections';

// ORG-UX-1 (Directive v1.0 LOCKED §4.3, Lead Correction A) — who sees which Organization
// pages is decided by the BACKEND from the ADR-0035 role model (GET /v1/me/products, the
// `org` entry's org_access):
//   admin     — tenant_owner / tenant_admin: every Organization section
//   templates — a template author/approver without an organization role (account
//               manager, recruiting manager, lead recruiter): Our templates + Template
//               gallery only
//   none      — App Home only (any /org/* page → App Home with the denial notice)
// The front end NEVER derives organization administration from scope possession (a
// `tenant:admin:*` scope or the directory read alone is not organization administration).
// This is navigation only: every Organization API keeps its own server-side scope guard.

export type OrgAccessState = { readonly status: 'loading' } | { readonly status: 'ready'; readonly access: OrgAccessTier; readonly products: ProductAvailabilityView } | { readonly status: 'error' };

/** The server-evaluated Organization access tier for this session. */
export function useOrgAccess(fetchFn: () => Promise<ProductAvailabilityView> = fetchMyProducts): OrgAccessState & { readonly retry: () => void } {
  const products = useMyProducts(fetchFn);
  if (products.status === 'ready') return { status: 'ready', access: orgAccessOf(products.view), products: products.view, retry: products.retry };
  return products.status === 'loading' ? { status: 'loading', retry: products.retry } : { status: 'error', retry: products.retry };
}

// Session-scope helpers used only for ACTION-level affordances inside a page the server
// already admitted (e.g. Approve needs document_template:manage). Never a page gate.
export const DOC_TEMPLATE_MANAGE_SCOPE = 'document_template:manage';
export const DOC_TEMPLATE_AUTHOR_SCOPE = 'document_template:author';

export function canApproveTemplates(session: Session): boolean {
  return session.scopes.includes(DOC_TEMPLATE_MANAGE_SCOPE);
}

export function canAuthorTemplates(session: Session): boolean {
  return session.scopes.includes(DOC_TEMPLATE_AUTHOR_SCOPE) || canApproveTemplates(session);
}

/** True when the session may grant/remove tenant_owner (ROLES-1: only an owner). */
export function isTenantOwnerSession(roleKeys: readonly string[]): boolean {
  return roleKeys.includes('tenant_owner');
}
