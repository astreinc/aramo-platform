import { AramoError, type VisibilityContextShape } from '@aramo/common';

// CONTACTS-1 W-2 — the D4b visibility test shared by the write paths. Same
// rule as findByIdForActor: see_all_company → visible; otherwise the id must
// be in the resolved visible set (null set = unrestricted).
export function isCompanyVisible(visibility: VisibilityContextShape, company_id: string): boolean {
  if (visibility.see_all_company) return true;
  const visible = visibility.visible_client_ids;
  return visible === null || visible.has(company_id);
}

// CONTACTS-1 W-2 — the write-path 404. Identical code + message to the
// invisible GET /v1/companies/:id so a write never reveals whether an
// out-of-visibility company exists.
export function companyNotFound(requestId: string, id: string): AramoError {
  return new AramoError('NOT_FOUND', 'Company not found in tenant (or not visible to actor)', 404, {
    requestId,
    details: { id },
  });
}
