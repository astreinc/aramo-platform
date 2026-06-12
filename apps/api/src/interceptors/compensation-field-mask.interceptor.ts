import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { AuthContextType } from '@aramo/auth';
import {
  COMPENSATION_FIELD_KEYS,
  COMPANY_COMMERCIAL_FIELD_KEYS,
  REQUISITION_FINANCIAL_FIELD_KEYS,
  omitMaskedCompensationFields,
  omitMaskedCommercialFields,
  omitMaskedFinancialFields,
} from '@aramo/field-masking';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

// AUTHZ-D5 — CompensationFieldMaskInterceptor.
//
// Shape-1 global interceptor (mirrors libs/visibility's
// VisibilityInterceptor): registered via APP_INTERCEPTOR at apps/api so
// the AuthContext set by JwtAuthGuard is available on the request when
// the response is shaped. Runs AFTER controller methods complete; walks
// the response value and applies the libs/field-masking omit-by-scope
// to any object that carries a compensation field key.
//
// Why shape-driven (NOT route-keyed): the requisition read DTO is the
// only comp-bearing surface today, but the matrix is the same wherever
// these fields surface — keying on shape ("has a comp field key") makes
// any future comp-bearing endpoint mask correctly without an interceptor
// re-wire. The set of comp field keys is the closed catalog at
// libs/field-masking; collisions with unrelated DTOs would be wrong but
// the field names (`pay_rate_amount` etc.) are domain-specific enough
// that the risk is negligible.
//
// Skip-conditions: requests without an AuthContext (e.g. /health,
// /auth/*) pass through unmasked — there is no actor to mask against.
// The visibility-record-level filter (D4b) has already decided the
// actor can see the record; D5 only masks WHICH FIELDS on that record.
@Injectable()
export class CompensationFieldMaskInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { authContext?: AuthContextType }>();
    const authContext = req.authContext;
    return next.handle().pipe(
      map((value) => {
        if (authContext === undefined) return value;
        return walkAndMask(value, authContext.scopes);
      }),
    );
  }
}

// Walk a response value and apply the comp-field mask to any object that
// carries at least one comp field key. Arrays recurse element-wise; plain
// objects recurse property-wise so list shapes like `{ items: [...] }`
// and nested requisition views in compound responses are masked too.
//
// Non-object / non-array values (strings, numbers, null, undefined,
// dates) pass through unchanged. The function does NOT clone non-comp
// objects — it returns the same reference if no mask applies (the
// containing object is shallow-cloned only when a child is replaced).
function walkAndMask(value: unknown, scopes: readonly string[]): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = [];
    for (const item of value) {
      const masked = walkAndMask(item, scopes);
      if (masked !== item) changed = true;
      out.push(masked);
    }
    return changed ? out : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  const obj = value as Record<string, unknown>;

  // Is this a comp-bearing object? Check for any comp field key.
  //
  // Job-Module — the requisition financial-planning fields live on the SAME
  // RequisitionView as the compensation fields, gated by their own scope
  // (requisition:view:financials). Apply BOTH omits on a comp-bearing view:
  // each deletes its own field set, so they compose (a partial-scope actor
  // can be shown comp but masked financials, or vice versa). The financials
  // branch below also catches any financials-bearing view that carries no
  // comp field key. Both omits return a shallow clone, so chaining is safe.
  const isCompBearing = COMPENSATION_FIELD_KEYS.some((k) => k in obj);
  const isFinancialsBearing = REQUISITION_FINANCIAL_FIELD_KEYS.some(
    (k) => k in obj,
  );
  if (isCompBearing || isFinancialsBearing) {
    let masked = obj;
    if (isCompBearing) masked = omitMaskedCompensationFields(masked, scopes);
    if (isFinancialsBearing) masked = omitMaskedFinancialFields(masked, scopes);
    return masked;
  }

  // Company-Fields v1.1 — the same shape-driven mask for company commercial
  // fields, gated by company:read_commercial. Disjoint from comp-bearing
  // objects in practice (CompanyView never carries pay_rate_* etc.), so a
  // parallel branch is correct; same omit-by-DELETE contract.
  const isCommercialBearing = COMPANY_COMMERCIAL_FIELD_KEYS.some((k) => k in obj);
  if (isCommercialBearing) {
    return omitMaskedCommercialFields(obj, scopes);
  }

  // Recurse into properties — list shapes / nested compounds.
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const masked = walkAndMask(v, scopes);
    if (masked !== v) changed = true;
    out[k] = masked;
  }
  return changed ? out : value;
}
