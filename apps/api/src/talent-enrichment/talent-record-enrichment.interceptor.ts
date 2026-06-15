import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { AuthContextType } from '@aramo/auth';
import type {
  TalentRecordView,
  TalentSearchQuery,
} from '@aramo/talent-record';
import type { Request } from 'express';
import { from, of, type Observable } from 'rxjs';
import { switchMap } from 'rxjs/operators';

import { TalentRecordEnrichmentService } from './talent-record-enrichment.service.js';

// Segment 3 — TalentRecordEnrichmentInterceptor.
//
// Global APP_INTERCEPTOR (mirrors CompensationFieldMaskInterceptor): registered
// AFTER VisibilityInterceptor so both `req.authContext` (JwtAuthGuard) and
// `req.resolveVisibleRequisitionIds` (VisibilityInterceptor) are set when the
// response is shaped. ROUTE-GUARDED to the talent-records LIST route only —
// the lib controller produces the single-schema `{items}`; this enriches each
// item with the three composed read-model fields (last_activity_at,
// consent_summary, current_stage) via the batched composer.
//
// Skip-conditions: non-target routes, missing AuthContext, or a non-list shape
// pass through untouched.
type EnrichRequest = Request & {
  authContext?: AuthContextType;
  resolveVisibleRequisitionIds?: () => Promise<ReadonlySet<string> | null>;
  // Segment 4b — stashed by the lib controller's paged branch so this layer
  // (the only one that may read activity/consent/pipeline) can compose the
  // FULL-SET cross-schema facet counts onto the paged response.
  talentSearchQuery?: TalentSearchQuery;
};

@Injectable()
export class TalentRecordEnrichmentInterceptor implements NestInterceptor {
  constructor(private readonly composer: TalentRecordEnrichmentService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<EnrichRequest>();
    const authContext = req.authContext;
    const isListRoute =
      req.method === 'GET' && req.route?.path === '/v1/talent-records';

    return next.handle().pipe(
      switchMap((value) => {
        if (
          !isListRoute ||
          authContext === undefined ||
          value === null ||
          typeof value !== 'object' ||
          !Array.isArray((value as { items?: unknown }).items)
        ) {
          return of(value);
        }
        const items = (value as { items: TalentRecordView[] }).items;
        const resolve = req.resolveVisibleRequisitionIds;
        const searchQuery = req.talentSearchQuery;
        return from(
          (async () => {
            const visible = resolve ? await resolve() : null;
            const ctx = {
              tenant_id: authContext.tenant_id,
              visible_requisition_ids: visible,
            };
            // Enrich the loaded page AND (paged branch only) compute the
            // FULL-SET cross-schema facet counts, concurrently.
            const [enriched, crossFacets] = await Promise.all([
              this.composer.enrich(items, ctx),
              searchQuery
                ? this.composer.crossFacets(searchQuery, ctx)
                : Promise.resolve(undefined),
            ]);
            const next = { ...(value as object), items: enriched };
            return crossFacets
              ? { ...next, cross_facets: crossFacets }
              : next;
          })(),
        );
      }),
    );
  }
}
