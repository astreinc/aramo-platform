import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ServiceTokenError, ServiceTokenService, type ServicePrincipal } from '@aramo/intelligence-core';
import { INTELLIGENCE_INGEST_SCOPE, type IntelligenceScope } from '@aramo/intelligence-contracts';

// ATI-SEP-1 T2/T4–T6 — bearer service-token guard. The token must verify
// (HS256, iss/aud, unexpired), its client must still be active with the same
// source system, and it must carry the route's scope: @RequireScope(...) on the
// handler or controller, intelligence:ingest when none is declared (T2 routes).
// A body's / path's source_system_id is checked against the principal by the service.

export const REQUIRED_SCOPE_KEY = 'intelligence:required-scope';
export const RequireScope = (scope: IntelligenceScope) => SetMetadata(REQUIRED_SCOPE_KEY, scope);

export interface ServiceRequest {
  headers: Record<string, string | string[] | undefined>;
  servicePrincipal?: ServicePrincipal;
}

@Injectable()
export class ServiceTokenGuard implements CanActivate {
  constructor(
    private readonly tokens: ServiceTokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ServiceRequest>();
    const header = req.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    const match = /^Bearer\s+(\S+)$/i.exec(value ?? '');
    if (!match) {
      throw new HttpException({ error: { code: 'UNAUTHENTICATED', message: 'a bearer service token is required' } }, HttpStatus.UNAUTHORIZED);
    }
    let principal: ServicePrincipal;
    try {
      principal = await this.tokens.verify(match[1] as string);
    } catch (err) {
      if (err instanceof ServiceTokenError && err.code === 'server_misconfigured') {
        throw new HttpException({ error: { code: 'SERVICE_UNAVAILABLE', message: 'service authentication is not configured' } }, HttpStatus.SERVICE_UNAVAILABLE);
      }
      throw new HttpException({ error: { code: 'UNAUTHENTICATED', message: 'the bearer service token is invalid' } }, HttpStatus.UNAUTHORIZED);
    }
    const required =
      this.reflector.getAllAndOverride<IntelligenceScope | undefined>(REQUIRED_SCOPE_KEY, [context.getHandler(), context.getClass()]) ??
      INTELLIGENCE_INGEST_SCOPE;
    if (!principal.scopes.includes(required)) {
      throw new HttpException({ error: { code: 'FORBIDDEN', message: `scope ${required} is required` } }, HttpStatus.FORBIDDEN);
    }
    req.servicePrincipal = principal;
    return true;
  }
}
