import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

// Domain-Enforcement P3 §5 — persistence for identity."DomainVerificationDelegation".
// Only the token HASH is ever stored or queried. Every tenant-facing read/write is
// keyed by tenant_id (from the caller's JWT) so a tenant can never see or revoke
// another tenant's delegation.

export interface DelegationRow {
  id: string;
  tenant_id: string;
  delegate_email: string;
  token_hash: string;
  issued_by_user_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

@Injectable()
export class DomainVerificationDelegationRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(row: Omit<DelegationRow, 'revoked_at' | 'last_used_at'>): Promise<DelegationRow> {
    return this.prisma.domainVerificationDelegation.create({ data: row });
  }

  // Active = not revoked and not expired at `now`, newest first.
  listActive(tenantId: string, now: Date): Promise<DelegationRow[]> {
    return this.prisma.domainVerificationDelegation.findMany({
      where: { tenant_id: tenantId, revoked_at: null, expires_at: { gt: now } },
      orderBy: { created_at: 'desc' },
    });
  }

  countActive(tenantId: string, now: Date): Promise<number> {
    return this.prisma.domainVerificationDelegation.count({
      where: { tenant_id: tenantId, revoked_at: null, expires_at: { gt: now } },
    });
  }

  findForTenant(tenantId: string, id: string): Promise<DelegationRow | null> {
    return this.prisma.domainVerificationDelegation.findFirst({
      where: { id, tenant_id: tenantId },
    });
  }

  // Revoke iff still un-revoked; returns whether this call revoked it.
  async revoke(tenantId: string, id: string, now: Date): Promise<boolean> {
    const r = await this.prisma.domainVerificationDelegation.updateMany({
      where: { id, tenant_id: tenantId, revoked_at: null },
      data: { revoked_at: now },
    });
    return r.count === 1;
  }

  findByTokenHash(tokenHash: string): Promise<DelegationRow | null> {
    return this.prisma.domainVerificationDelegation.findUnique({
      where: { token_hash: tokenHash },
    });
  }

  async touch(id: string, now: Date): Promise<void> {
    await this.prisma.domainVerificationDelegation.update({
      where: { id },
      data: { last_used_at: now },
    });
  }
}
