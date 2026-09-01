import { Injectable } from '@nestjs/common';

import {
  type AuthzVersionTx,
  bumpPrincipalVersion,
  bumpPrincipalsWithRoleVersion,
  ensureBaselineVersion,
} from './authorization-version.ops.js';
import { PrismaService } from './prisma/prisma.service.js';

// HF-AUTH-1 — DI wrapper over the standalone authorization-version ops
// (authorization-version.ops.ts). Callers that resolve this via DI (the app-layer
// resolver's identity implementation, the seed's grant-catalog path) use these
// methods; IdentityRepository calls the ops directly with its live tx client to
// keep the version bump atomic with the mutation without a constructor change.
//
// Postgres (this table) is the authority for a principal's monotonic authorization
// revision. Redis only CACHES the resolved scope snapshot under the version this
// service returns. The compact JWT carries the version it was minted at; the guard
// version-matches for the immediate-revocation SLA.
@Injectable()
export class AuthorizationVersionService {
  constructor(private readonly prisma: PrismaService) {}

  // Current authoritative version for (tenant, principal). Absent row = baseline 1.
  async getCurrentVersion(args: { tenant_id: string; principal_id: string }): Promise<number> {
    const row = await this.prisma.authorizationVersion.findUnique({
      where: {
        tenant_id_principal_id: { tenant_id: args.tenant_id, principal_id: args.principal_id },
      },
      select: { version: true },
    });
    return row?.version ?? 1;
  }

  async ensureBaseline(
    tx: AuthzVersionTx,
    args: { tenant_id: string; principal_id: string },
  ): Promise<void> {
    return ensureBaselineVersion(tx, args);
  }

  async bumpPrincipal(
    tx: AuthzVersionTx,
    args: { tenant_id: string; principal_id: string },
  ): Promise<number> {
    return bumpPrincipalVersion(tx, args);
  }

  async bumpPrincipalsWithRole(tx: AuthzVersionTx, args: { role_id: string }): Promise<number> {
    return bumpPrincipalsWithRoleVersion(tx, args);
  }
}
