import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';
import {
  CanonicalMatchShadowRepository,
  computeShadowObservations,
  type NormalizedCriticalRequirement,
  type NormalizedTalentSkill,
} from '@aramo/examination';
import { RequisitionSkillRequirementRepository } from '@aramo/requisition';
import { TalentCanonicalCoverageRepository } from '@aramo/talent-evidence';
import { normalizeSkillSurfaceForm } from '@aramo/talent-extraction';

import { CanonicalMatchShadowConfig } from './canonical-match-shadow.config.js';

// SKILL-TAX-1E — the canonical SHADOW comparator. Runs in apps/api (the ONLY place
// that may legally read requisition (scope:ats) alongside talent-evidence
// (scope:cip); same composition-root privilege the canonical-reconcile processor
// uses). Invoked AFTER the authoritative examine has persisted. Two hard contracts:
//   1. DARK — does nothing unless SKILL_CANONICAL_SHADOW_ENABLED is on.
//   2. BEST-EFFORT / ISOLATED — every error is swallowed + logged; the shadow can
//      NEVER fail the authoritative examine (its result is already returned).
// It observes ONLY (writes an append-only shadow row); it NEVER touches the
// authoritative matcher, snapshot, or response.
@Injectable()
export class CanonicalMatchShadowComparator {
  constructor(
    private readonly config: CanonicalMatchShadowConfig,
    private readonly requirements: RequisitionSkillRequirementRepository,
    private readonly talentCanonical: TalentCanonicalCoverageRepository,
    private readonly shadowRepo: CanonicalMatchShadowRepository,
    @Inject('CanonicalMatchShadowLogger') private readonly logger: AramoLogger,
  ) {}

  // Observe the canonical view of the critical-skill match for one examination.
  // Never throws. Returns the number of observations persisted (0 when dark or on
  // a swallowed error) purely for test/telemetry visibility.
  async observe(args: {
    tenant_id: string;
    examination_id: string;
    talent_id: string;
    golden_profile_id: string;
    requisition_id: string;
    golden_critical_skill_names: readonly string[];
  }): Promise<number> {
    if (!this.config.isEnabled()) return 0; // DARK — zero behavior change.
    try {
      const requirements = await this.requirements.listForGoldenProfile(
        args.tenant_id,
        args.golden_profile_id,
      );
      const talentSkills = await this.talentCanonical.listCanonicalSkillsForTalent({
        tenant_id: args.tenant_id,
        talent_id: args.talent_id,
      });

      // v1 compares requirement_type='critical' ONLY (no required/preferred weight).
      const criticalRequirements: NormalizedCriticalRequirement[] = requirements
        .filter((r) => r.requirement_type === 'critical')
        .map((r) => ({
          norm: normalizeSkillSurfaceForm(r.raw_surface_form),
          raw_surface_form: r.raw_surface_form,
          canonical_skill_id: r.canonical_skill_id,
        }));

      const normTalentSkills: NormalizedTalentSkill[] = talentSkills.map((t) => ({
        norm: normalizeSkillSurfaceForm(t.surface_form),
        canonical_skill_id: t.canonical_skill_id,
      }));

      const observations = computeShadowObservations({
        criticalRequirements,
        talentSkills: normTalentSkills,
        goldenCriticalNorms: args.golden_critical_skill_names.map((n) => normalizeSkillSurfaceForm(n)),
      });

      const persisted = await this.shadowRepo.persistObservations({
        tenant_id: args.tenant_id,
        examination_id: args.examination_id,
        talent_id: args.talent_id,
        golden_profile_id: args.golden_profile_id,
        requisition_id: args.requisition_id,
        observations,
      });
      this.logger.log({
        event: 'canonical_match_shadow_observed',
        examination_id: args.examination_id,
        observations: persisted,
      });
      return persisted;
    } catch (err) {
      // Best-effort: the shadow must NEVER fail the authoritative examine.
      this.logger.warn({
        event: 'canonical_match_shadow_failed',
        examination_id: args.examination_id,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }
}
