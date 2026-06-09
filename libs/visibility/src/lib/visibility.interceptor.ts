import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { AuthContextType } from '@aramo/auth';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

import type { VisibilityContext } from './visibility-context.js';
import { VisibilityResolverService } from './visibility-resolver.service.js';

// AUTHZ-D4b — VisibilityInterceptor (the Shape-1 wiring per Gate-5 Ruling 1).
//
// Global interceptor (registered via APP_INTERCEPTOR in apps/api). On every
// request that reaches a controller, attach LAZY + MEMOIZED resolver
// functions to the request object:
//
//   await req.resolveVisibility()              → VisibilityContext
//   await req.resolveVisibleRequisitionIds()   → ReadonlySet | null
//   await req.resolveVisiblePipelineIds()      → ReadonlySet | null
//
// Each is independently memoized per request. The augmentations are
// declared in @aramo/common (so every entity lib sees them without
// importing @aramo/visibility — the cycle-avoidance).
//
// Structural enforcement is at the REPO signature (entity read methods
// require the resolved values as parameters) — a forgotten controller
// call is caught by the type-checker, not by runtime drift.
//
// Skip-conditions: requests without an AuthContext (e.g. /health, /auth/*)
// get a rejecting resolver — calling it before JwtAuthGuard runs is a
// programming error (visibility is only defined under authentication).
@Injectable()
export class VisibilityInterceptor implements NestInterceptor {
  constructor(private readonly resolver: VisibilityResolverService) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { authContext?: AuthContextType }>();

    let cachedBase: Promise<VisibilityContext> | undefined;
    const getBase = (): Promise<VisibilityContext> => {
      if (cachedBase !== undefined) return cachedBase;
      const authContext = req.authContext;
      if (authContext === undefined) {
        return Promise.reject(
          new Error(
            'VisibilityInterceptor: AuthContext required before visibility resolution (JwtAuthGuard must run first)',
          ),
        );
      }
      cachedBase = this.resolver.resolveForActor(authContext);
      return cachedBase;
    };
    req.resolveVisibility = getBase;

    let cachedReqIds: Promise<ReadonlySet<string> | null> | undefined;
    req.resolveVisibleRequisitionIds = (): Promise<
      ReadonlySet<string> | null
    > => {
      if (cachedReqIds !== undefined) return cachedReqIds;
      cachedReqIds = getBase().then((ctx) =>
        this.resolver.resolveVisibleRequisitionIds(ctx),
      );
      return cachedReqIds;
    };

    let cachedPipelineIds:
      | Promise<ReadonlySet<string> | null>
      | undefined;
    req.resolveVisiblePipelineIds = (): Promise<
      ReadonlySet<string> | null
    > => {
      if (cachedPipelineIds !== undefined) return cachedPipelineIds;
      cachedPipelineIds = getBase().then((ctx) =>
        this.resolver.resolveVisiblePipelineIds(ctx),
      );
      return cachedPipelineIds;
    };

    // Tasks backend — the contact visible-id set (the 4th owner_type's
    // resolver). Memoized per request like the others.
    let cachedContactIds: Promise<ReadonlySet<string> | null> | undefined;
    req.resolveVisibleContactIds = (): Promise<
      ReadonlySet<string> | null
    > => {
      if (cachedContactIds !== undefined) return cachedContactIds;
      cachedContactIds = getBase().then((ctx) =>
        this.resolver.resolveVisibleContactIds(ctx),
      );
      return cachedContactIds;
    };

    return next.handle();
  }
}
