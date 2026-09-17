import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// SKILL-TAX Canonical Reconciliation Activation — read-only coverage + backstop
// eligibility for the Talent side. A SEPARATE repository (not TalentEvidenceRepository)
// so the closed-surface governance of that repository is untouched. Pure reads.

export interface CanonicalCoverage {
  total: number;
  resolved: number;
  unresolved: number;
  // never reconciled (canonicalized_at IS NULL).
  unattempted: number;
}

@Injectable()
export class TalentCanonicalCoverageRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Backstop eligibility (§ watermark guard): distinct talents that have any
  // NEVER-reconciled evidence row created at/after the activation watermark.
  // Pre-watermark historical rows are IGNORED (no de-facto backfill).
  async findTalentsWithUnreconciledEvidence(args: {
    since: Date;
    limit: number;
  }): Promise<Array<{ tenant_id: string; talent_id: string }>> {
    const rows = await this.prisma.talentSkillEvidence.findMany({
      where: { canonicalized_at: null, created_at: { gte: args.since } },
      select: { tenant_id: true, talent_id: true },
      distinct: ['tenant_id', 'talent_id'],
      orderBy: [{ tenant_id: 'asc' }, { talent_id: 'asc' }],
      take: args.limit,
    });
    return rows;
  }

  // Coverage telemetry (queryable, no new table): eligible = attempted rows.
  async coverage(): Promise<CanonicalCoverage> {
    const [total, resolved, unresolved, unattempted] = await Promise.all([
      this.prisma.talentSkillEvidence.count(),
      this.prisma.talentSkillEvidence.count({ where: { canonicalization_status: 'RESOLVED' } }),
      this.prisma.talentSkillEvidence.count({ where: { canonicalization_status: 'UNRESOLVED' } }),
      this.prisma.talentSkillEvidence.count({ where: { canonicalized_at: null } }),
    ]);
    return { total, resolved, unresolved, unattempted };
  }
}
