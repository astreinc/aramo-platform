import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { AuthContextType } from '@aramo/auth';
import type { PipelineView } from '@aramo/pipeline';
import type { Request } from 'express';
import { from, of, type Observable } from 'rxjs';
import { switchMap } from 'rxjs/operators';

import { PipelineTalentEnrichmentService } from './pipeline-talent-enrichment.service.js';

// Requisition-expander enrichment interceptor (LOCKED Aramo-Requisition-Expander-
// Talent-Rate-Columns v1.0). Global APP_INTERCEPTOR, registered AFTER
// JwtAuthGuard so `req.authContext` (tenant_id + scopes) is set. ROUTE-GUARDED
// to the pipelines LIST route only — the lib controller returns the single-
// schema `{items: PipelineView[]}`; this composes the five talent fields onto
// each item via the batched composer. R-LAYERING: the `talent:read` scope is the
// EXISTENCE gate — a caller with `pipeline:read` but not `talent:read` gets the
// rows with all five fields null (never leaked).
//
// Skip-conditions: non-target route, missing AuthContext, or a non-`{items}`
// shape pass through untouched.
type EnrichRequest = Request & { authContext?: AuthContextType };

@Injectable()
export class PipelineTalentEnrichmentInterceptor implements NestInterceptor {
  constructor(private readonly composer: PipelineTalentEnrichmentService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<EnrichRequest>();
    const authContext = req.authContext;
    const isListRoute =
      req.method === 'GET' && req.route?.path === '/v1/pipelines';

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
        const items = (value as { items: PipelineView[] }).items;
        return from(
          (async () => {
            const enriched = await this.composer.enrich(items, {
              tenant_id: authContext.tenant_id,
              // R-LAYERING gate 1 — authz decides existence.
              canReadTalent: authContext.scopes.includes('talent:read'),
            });
            return { ...(value as object), items: enriched };
          })(),
        );
      }),
    );
  }
}
