// AUTHZ-D5 — libs/field-masking (a NEW terminal lib).
//
// Field-level compensation masking by role at the response layer. D4b
// masked WHICH RECORDS the actor sees; D5 masks WHICH FIELDS on a record
// they see. The two compose: D4b drops invisible records before fetch,
// D5 omits unauthorised fields before serialisation.
//
// Terminal lib (mirrors libs/visibility): no entity lib imports
// @aramo/field-masking. The interceptor at apps/api calls into this lib;
// the entity DTOs are the input it receives. The dependency graph is
// `apps/api → field-masking`; no reverse edge exists — verified by
// lint:nx-boundaries.
//
// Pure: no Nest decorators, no DI, no async — just the scope→field-set
// map, the omit function, and the non-invertibility invariant validator.
// The interceptor that wires it into NestJS lives at apps/api per the
// commit plan §1.
//
// EEO (the strictest form of field-masking) is DEFERRED to Settings. The
// mechanism here (scope-keyed field omission) is reusable by an
// eeo:view:* scope family on the talent read DTO — but EEO needs
// structural separation (protected-class data non-derivable for ALL
// roles in the decision path), which D5's soft-boundary design does NOT
// guarantee. The Settings EEO DDR (legal/Architect review) builds on
// this mechanism, NOT inside D5.

export {
  COMPENSATION_VIEW_PAY,
  COMPENSATION_VIEW_BILL,
  COMPENSATION_VIEW_REVENUE,
  COMPENSATION_VIEW_SPREAD_AMOUNT,
  COMPENSATION_VIEW_SPREAD_PERCENT,
  COMPENSATION_VIEW_MARGIN_PERCENT,
  COMPENSATION_VIEW_SCOPES,
  COMPENSATION_SPREAD_SCOPES,
  COMPENSATION_EDIT_PAY,
  COMPENSATION_EDIT_BILL,
  COMPENSATION_EDIT_SCOPES,
} from './lib/compensation-scope.js';
export type {
  CompensationViewScope,
  CompensationEditScope,
} from './lib/compensation-scope.js';

export {
  COMPENSATION_FIELD_KEYS,
  assertNonInvertibleBundle,
  omitMaskedCompensationFields,
  visibleCompensationFields,
} from './lib/compensation-field-map.js';
export type { CompensationFieldKey } from './lib/compensation-field-map.js';

// Company-Fields v1.1 — the company commercial mask (second consumer).
export {
  COMPANY_READ_COMMERCIAL,
  COMPANY_COMMERCIAL_FIELD_KEYS,
  omitMaskedCommercialFields,
} from './lib/commercial-field-map.js';
export type { CompanyCommercialFieldKey } from './lib/commercial-field-map.js';

// The promoted generic omit helper (rule-of-three; all three maps delegate).
export { omitFieldsByScopeMap } from './lib/omit-by-scope.js';

// Job-Module — the requisition financials mask (third consumer).
export {
  REQUISITION_VIEW_FINANCIALS,
  REQUISITION_FINANCIAL_FIELD_KEYS,
  omitMaskedFinancialFields,
} from './lib/financials-field-map.js';
export type { RequisitionFinancialFieldKey } from './lib/financials-field-map.js';
