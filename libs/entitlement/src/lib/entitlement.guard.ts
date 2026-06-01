import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import type { Request } from 'express';

import type { Capability } from './capability.js';
import { REQUIRED_CAPABILITIES_KEY } from './entitlement.metadata.js';
import { EntitlementRepository } from './entitlement.repository.js';

// EntitlementGuard — the tenant-capability checkpoint that runs AFTER
// JwtAuthGuard and BEFORE RolesGuard (PR-A1b Ruling 1).
//
// Reads @RequireCapability metadata off the handler (falls back to the
// class) and rejects with TENANT_CAPABILITY_NOT_ENTITLED (403) when the
// tenant (AuthContext.tenant_id) is not entitled to one or more required
// capabilities. All-or-nothing on the capabilities (every required
// capability must be entitled — mirrors RolesGuard scope semantics).
//
// DISTINCT AXIS from RolesGuard (Ruling 1 — the central proof):
//   - EntitlementGuard gates the TENANT axis (coarser, per-tenant config).
//   - RolesGuard gates the USER/ROLE axis (per-principal permission).
// A scoped user in an unentitled tenant is rejected HERE, never reaching
// RolesGuard. The two guards are independently composable.
//
// Routes that don't decorate @RequireCapability pass through (the guard
// is a no-op when no metadata is set), preserving existing routes that
// haven't migrated.
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly repository: EntitlementRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const cls = context.getClass();

    const requiredCapabilities = this.reflector.getAllAndOverride<
      Capability[] | undefined
    >(REQUIRED_CAPABILITIES_KEY, [handler, cls]);

    // No decorator => no entitlement constraint added by this guard.
    if (
      requiredCapabilities === undefined ||
      requiredCapabilities.length === 0
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
        'TENANT_CAPABILITY_NOT_ENTITLED',
        'Authorization context not established',
        403,
        { requestId, details: { reason: 'auth_context_missing' } },
      );
    }

    const entitled = await this.repository.getCapabilities(
      authContext.tenant_id,
    );
    const missing = requiredCapabilities.filter((c) => !entitled.has(c));
    if (missing.length > 0) {
      throw new AramoError(
        'TENANT_CAPABILITY_NOT_ENTITLED',
        'Tenant not entitled to required capabilities',
        403,
        {
          requestId,
          details: {
            tenant_id: authContext.tenant_id,
            required_capabilities: requiredCapabilities,
            missing_capabilities: missing,
          },
        },
      );
    }

    return true;
  }
}
