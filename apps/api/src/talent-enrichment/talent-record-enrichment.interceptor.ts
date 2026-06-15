import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { AuthContextType } from '@aramo/auth';
import type { TalentRecordView } from '@aramo/talent-record';
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
        return from(
          (async () => {
            const visible = resolve ? await resolve() : null;
            const enriched = await this.composer.enrich(items, {
              tenant_id: authContext.tenant_id,
              visible_requisition_ids: visible,
            });
            return { ...(value as object), items: enriched };
          })(),
        );
      }),
    );
  }
}
