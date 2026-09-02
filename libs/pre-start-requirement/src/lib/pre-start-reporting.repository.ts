import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import {
  isResolvedStatus,
  isRequirementStatus,
  type RequirementStatusValue,
} from './pre-start-requirement-vocab.js';
import type { PreStartOnboardingRollupSnapshot } from './pre-start-requirement.types.js';

// L5-P8 — the reporting-facing READ repository (option (a), directive Amendment A1).
//
// Read-only, reporting-specific aggregate over the first-class pre-start facts.
// It is the sole thing the reporting→pre-start module edge PULLS. Every method
// is a tenant-scoped SELECT/groupBy; there is NO write path here and none is
// exported — reporting cannot mutate onboarding requirements. Provided +
// exported by PreStartReportingReadModule; consumed by libs/reporting via the
// declared reporting→pre-start-requirement edge (forward, acyclic: pre-start has
// no back-edge to reporting).
@Injectable()
export class PreStartReportingRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Tenant-scoped onboarding rollup: the requirement-completion matrix
  // (type × status), the resolved/unresolved/blocking-unresolved totals, and the
  // readiness-decision history from the append-only ledger. Deterministic — no
  // wall-clock dependency.
  async readOnboardingRollup(args: {
    tenant_id: string;
  }): Promise<PreStartOnboardingRollupSnapshot> {
    const { tenant_id } = args;

    const [instanceGroups, blockingUnresolved, decisionGroups] = await Promise.all([
      this.prisma.preStartRequirementInstance.groupBy({
        by: ['requirement_type', 'status'],
        where: { tenant_id },
        _count: { _all: true },
      }),
      // The readiness-gap signal: blocking instances still in an unresolved
      // status. UNRESOLVED = NOT (SATISFIED|WAIVED|CANCELED).
      this.prisma.preStartRequirementInstance.count({
        where: {
          tenant_id,
          blocking: true,
          status: { notIn: ['SATISFIED', 'WAIVED', 'CANCELED'] },
        },
      }),
      this.prisma.preStartReadinessDecision.groupBy({
        by: ['result', 'refusal_reason'],
        where: { tenant_id },
        _count: { _all: true },
      }),
    ]);

    const by_type_status = instanceGroups
      .filter((g): g is typeof g & { status: RequirementStatusValue } =>
        isRequirementStatus(g.status),
      )
      .map((g) => ({
        requirement_type: g.requirement_type,
        status: g.status,
        count: g._count._all,
      }))
      .sort((a, b) =>
        a.requirement_type === b.requirement_type
          ? a.status.localeCompare(b.status)
          : a.requirement_type.localeCompare(b.requirement_type),
      );

    let total = 0;
    let resolved = 0;
    for (const cell of by_type_status) {
      total += cell.count;
      if (isResolvedStatus(cell.status)) resolved += cell.count;
    }

    let ready = 0;
    let refused = 0;
    let refused_materialization_absent = 0;
    let refused_blocking_unresolved = 0;
    for (const g of decisionGroups) {
      const n = g._count._all;
      if (g.result === 'READY') {
        ready += n;
      } else if (g.result === 'REFUSED') {
        refused += n;
        if (g.refusal_reason === 'materialization_absent') refused_materialization_absent += n;
        else if (g.refusal_reason === 'blocking_unresolved') refused_blocking_unresolved += n;
      }
    }

    return {
      by_type_status,
      totals: {
        total,
        resolved,
        unresolved: total - resolved,
        blocking_unresolved: blockingUnresolved,
      },
      readiness_decisions: {
        ready,
        refused,
        refused_materialization_absent,
        refused_blocking_unresolved,
      },
    };
  }
}
