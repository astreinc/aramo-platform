import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';
import { TalentCanonicalCoverageRepository } from '@aramo/talent-evidence';
import { RequisitionSkillRequirementRepository } from '@aramo/requisition';

// SKILL-TAX Canonical Reconciliation Activation — lightweight, queryable coverage
// telemetry (no new persistence table). Aggregate reads only; emits ratios so we
// can PROVE the canonical substrate is actually being populated. The later 1E
// shadow slice gets its own append-only observation store — this only proves
// activation.
export interface CoverageReport {
  talent: { total: number; resolved: number; unresolved: number; unattempted: number; canonical_coverage: number };
  requisition: { total: number; resolved: number; unresolved: number; canonical_coverage: number };
}

function ratio(resolved: number, unresolved: number): number {
  const eligible = resolved + unresolved; // eligible = attempted rows
  return eligible === 0 ? 0 : resolved / eligible;
}

@Injectable()
export class CanonicalReconcileCoverageService {
  constructor(
    private readonly talentCoverage: TalentCanonicalCoverageRepository,
    private readonly requirements: RequisitionSkillRequirementRepository,
    @Inject('CanonicalReconcileCoverageLogger') private readonly logger: AramoLogger,
  ) {}

  async report(): Promise<CoverageReport> {
    const talent = await this.talentCoverage.coverage();
    const requisition = await this.requirements.coverage();
    const out: CoverageReport = {
      talent: { ...talent, canonical_coverage: ratio(talent.resolved, talent.unresolved) },
      requisition: { ...requisition, canonical_coverage: ratio(requisition.resolved, requisition.unresolved) },
    };
    this.logger.log({ event: 'canonical_reconcile_coverage', ...out });
    return out;
  }
}
