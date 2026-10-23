import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ServiceTokenError, ServiceTokenService, type ServicePrincipal } from '@aramo/intelligence-core';
import { INTELLIGENCE_INGEST_SCOPE } from '@aramo/intelligence-contracts';

// ATI-SEP-1 T2 — bearer service-token guard for the ingestion endpoints. The
// token must verify (HS256, iss/aud, unexpired), its client must still be
// active with the same source system, and it must carry intelligence:ingest.
// The body's source_system_id is checked against the principal by the service.

export interface ServiceRequest {
  headers: Record<string, string | string[] | undefined>;
  servicePrincipal?: ServicePrincipal;
}

@Injectable()
export class ServiceTokenGuard implements CanActivate {
  constructor(private readonly tokens: ServiceTokenService) {}

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
    if (!principal.scopes.includes(INTELLIGENCE_INGEST_SCOPE)) {
      throw new HttpException({ error: { code: 'FORBIDDEN', message: `scope ${INTELLIGENCE_INGEST_SCOPE} is required` } }, HttpStatus.FORBIDDEN);
    }
    req.servicePrincipal = principal;
    return true;
  }
}
