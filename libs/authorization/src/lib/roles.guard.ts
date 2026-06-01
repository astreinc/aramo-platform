import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import type { Request } from 'express';

import {
  REQUIRED_SCOPES_KEY,
  REQUIRES_SITE_MATCH_KEY,
} from './authorization.metadata.js';

// RolesGuard — the AuthZ checkpoint that runs AFTER JwtAuthGuard.
//
// Reads @RequireScopes / @RequireSiteMatch metadata off the handler (and
// falls back to the class) and rejects with INSUFFICIENT_PERMISSIONS (403)
// when:
//   1. Required scopes are not a subset of AuthContext.scopes.
//   2. @RequireSiteMatch is present AND (a) the claim site_id is missing,
//      or (b) the route's requested site_id does not match the claim.
//
// All-or-nothing on the scopes (every required scope must be present).
// Routes that don't decorate scope requirements pass through (the guard
// is a no-op when no @RequireScopes is set), preserving the M3 PR-8
// consumer_type-only routes that haven't migrated yet.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    const cls = context.getClass();

    const requiredScopes = this.reflector.getAllAndOverride<
      string[] | undefined
    >(REQUIRED_SCOPES_KEY, [handler, cls]);
    const requiresSiteMatch =
      this.reflector.getAllAndOverride<boolean | undefined>(
        REQUIRES_SITE_MATCH_KEY,
        [handler, cls],
      ) === true;

    // No decorator => no authorization constraint added by this guard.
    if (
      (requiredScopes === undefined || requiredScopes.length === 0) &&
      !requiresSiteMatch
    ) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<
        Request & { authContext?: AuthContextType; requestId?: string }
      >();
    const requestId = request.requestId ?? 'unknown';
    const authContext = request.authContext;

    if (authContext === undefined) {
      // JwtAuthGuard must run first; if it did not, fail closed.
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'Authorization context not established',
        403,
        { requestId, details: { reason: 'auth_context_missing' } },
      );
    }

    if (requiredScopes !== undefined && requiredScopes.length > 0) {
      const have = new Set(authContext.scopes);
      const missing = requiredScopes.filter((s) => !have.has(s));
      if (missing.length > 0) {
        throw new AramoError(
          'INSUFFICIENT_PERMISSIONS',
          'Required scopes not granted',
          403,
          {
            requestId,
            details: {
              required_scopes: requiredScopes,
              missing_scopes: missing,
            },
          },
        );
      }
    }

    if (requiresSiteMatch) {
      const claimSite = authContext.site_id;
      const requestedSite = this.resolveRequestedSite(request);
      if (claimSite === undefined || claimSite === null) {
        throw new AramoError(
          'INSUFFICIENT_PERMISSIONS',
          'Site-scoped route requires site_id claim',
          403,
          { requestId, details: { reason: 'site_claim_missing' } },
        );
      }
      if (requestedSite !== undefined && requestedSite !== claimSite) {
        throw new AramoError(
          'INSUFFICIENT_PERMISSIONS',
          'Site claim does not match requested site',
          403,
          {
            requestId,
            details: {
              claim_site_id: claimSite,
              requested_site_id: requestedSite,
            },
          },
        );
      }
    }

    return true;
  }

  // Resolve the requested site_id from the route. Default: path param `site_id`
  // or `siteId`, then query `site_id`. Routes that carry the site in the body
  // are responsible for validating it themselves (the body is not parsed at
  // guard time in a consistent way across Nest middleware orders).
  private resolveRequestedSite(request: Request): string | undefined {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const fromParam = params['site_id'] ?? params['siteId'];
    if (typeof fromParam === 'string' && fromParam.length > 0) return fromParam;
    const queryRaw = request.query?.['site_id'];
    const fromQuery = Array.isArray(queryRaw) ? queryRaw[0] : queryRaw;
    if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
    return undefined;
  }
}
