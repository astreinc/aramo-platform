import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import {
  MINT_DENYING_STATUSES,
  TenantRepository,
  isTenantStatus,
} from '@aramo/identity';

import { ALLOW_WHEN_SUSPENDED_KEY } from './allow-when-suspended.decorator.js';

// Inc-3 PR-3.7 (Ruling R12 + Recon Surface 4) — the tenant WRITE-freeze.
//
// The mint gate (auth-service) refuses to issue a session for a SUSPENDED/CLOSED
// tenant, but a session minted just before suspension survives its ≤15-min
// access-token TTL. This interceptor bars the windows the mint gate left open: a
// still-valid session can READ but cannot WRITE to a suspended/closed tenant.
//
// A global APP_INTERCEPTOR (not a guard) registered FIRST in apps/api, so this
// blocking policy check runs before any response-shaping / enrichment work is
// spent. Interceptors execute POST-guards, so request.authContext is populated
// wherever JwtAuthGuard ran — the chain-position tension is moot by construction.
//
// Decision ladder (in order, each rung a skip); rung 5 is the only DB read — a
// single-PK findUnique of 3 columns (Surface 4's cheapest read; per-mutation cost
// accepted per R12, no cache invented here).
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class TenantWriteFreezeInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenantWriteFreezeInterceptor.name);

  constructor(
    private readonly tenantRepo: TenantRepository,
    private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = context
      .switchToHttp()
      .getRequest<
        Request & { authContext?: AuthContextType; requestId?: string }
      >();

    // Rung 1 — no authContext → skip. Public routes carry their own single-use-
    // token authority (invitation accept, cert-eligible, verification confirm);
    // they have no session and no tenant lifecycle to gate.
    const authContext = req.authContext;
    if (authContext === undefined) {
      return next.handle();
    }

    // Rung 2 — platform consumer → skip. Mint-gate parity: the operator MUST be
    // able to act on a suspended tenant (that is how it gets reactivated).
    if (authContext.consumer_type === 'platform') {
      return next.handle();
    }

    // Rung 3 — read methods → skip. The freeze is a WRITE freeze; reads survive
    // the TTL window by design (P4: "the exposure is reads-only").
    if (READ_METHODS.has(req.method)) {
      return next.handle();
    }

    // Rung 4 — @AllowWhenSuspended() present (handler or class) → skip. Applied
    // to zero routes today; the escape hatch for a future ruled exception.
    const allowWhenSuspended = this.reflector.getAllAndOverride<boolean>(
      ALLOW_WHEN_SUSPENDED_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowWhenSuspended === true) {
      return next.handle();
    }

    // Rung 5 — the lifecycle check (the cheapest read).
    const lifecycle = await this.tenantRepo.findLifecycleById(
      authContext.tenant_id,
    );
    const requestId = req.requestId ?? 'unknown';

    // Edge — a tenant row absent under a VALID JWT is anomalous. FAIL CLOSED: a
    // missing tenant must never fail open into writes. Deny as CLOSED, log the
    // anomaly (structured log, not an audit event — see below).
    if (lifecycle === null) {
      this.logger.warn({
        event: 'tenant_write_freeze_denied',
        reason: 'tenant_row_absent',
        tenant_id: authContext.tenant_id,
        method: req.method,
        request_id: requestId,
      });
      throw new AramoError('TENANT_CLOSED', 'Tenant is closed', 403, {
        requestId,
        details: { reason: 'tenant_row_absent', tenant_id: authContext.tenant_id },
      });
    }

    // MINT_DENYING_STATUSES = {SUSPENDED, CLOSED} — exact mint-gate parity.
    // PROVISIONED / ACTIVE / OFFBOARDING write normally.
    if (
      isTenantStatus(lifecycle.status) &&
      MINT_DENYING_STATUSES.has(lifecycle.status)
    ) {
      const code =
        lifecycle.status === 'SUSPENDED' ? 'TENANT_SUSPENDED' : 'TENANT_CLOSED';
      // Structured log, NOT an audit event: the suspension itself is already
      // audit-evented (with actor + reason); per-request denial audit is noise.
      this.logger.warn({
        event: 'tenant_write_freeze_denied',
        status: lifecycle.status,
        tenant_id: authContext.tenant_id,
        method: req.method,
        request_id: requestId,
      });
      throw new AramoError(
        code,
        `Tenant is ${lifecycle.status.toLowerCase()}`,
        403,
        {
          requestId,
          details: { reason: code.toLowerCase(), tenant_id: authContext.tenant_id },
        },
      );
    }

    return next.handle();
  }
}
