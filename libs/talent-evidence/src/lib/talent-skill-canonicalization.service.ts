import { Injectable } from '@nestjs/common';
import { SkillCanonicalizationService } from '@aramo/skills-taxonomy';

import { TalentEvidenceRepository } from './talent-evidence.repository.js';
import { aggregateCanonicalYears, type CanonicalUsageRow } from './canonical-skill-timeline.js';

// SKILL-TAX-1G — TalentSkillEvidence canonical reconciliation (talent-evidence
// owns the columns + this orchestrator; consumes skills-taxonomy's read-only
// SkillCanonicalizationService via the first talent-evidence→skills-taxonomy
// nx edge).
//
// Operates ONLY on existing stored evidence (surface_form + explicit version) —
// NO résumé re-parse, NO second AI call, NO new SkillUsage rows. It attaches the
// engine outcome (canonical_skill_id/version + status + method) to each row via a
// guarded UPDATE, then computes the canonical supported-years projection by
// INTERVAL UNION keyed by canonical_skill_id (§19) and writes it to the ADDITIVE
// TalentDerivedSnapshot.estimated_years_experience_by_canonical_skill — the
// legacy estimated_years_experience_by_skill (surface-derived) is never touched.
//
// Re-runnable, NOT write-once: every run re-resolves every row, so an unresolved
// row resolves later once an alias/version/merge lands in the taxonomy, and the
// result converges (idempotent) on unchanged inputs+taxonomy.

export interface ReconcileTalentResult {
  tenant_id: string;
  talent_id: string;
  total: number;
  resolved: number;
  unresolved: number;
  canonical_skill_count: number;
  snapshot_updated: boolean;
}

@Injectable()
export class TalentSkillCanonicalizationService {
  constructor(
    private readonly evidence: TalentEvidenceRepository,
    private readonly canonicalization: SkillCanonicalizationService,
  ) {}

  async reconcileTalent(tenantId: string, talentId: string): Promise<ReconcileTalentResult> {
    const rows = await this.evidence.listSkillEvidenceForCanonicalization({
      tenant_id: tenantId,
      talent_id: talentId,
    });

    const now = new Date();
    let resolved = 0;
    let unresolved = 0;

    for (const row of rows) {
      const result = await this.canonicalization.resolve({
        surfaceForm: row.surface_form,
        explicitVersion: row.version,
      });
      await this.evidence.updateSkillEvidenceCanonical(row.id, {
        canonical_skill_id: result.canonicalSkillId,
        canonical_version_id: result.canonicalVersionId,
        canonicalization_status: result.status,
        canonicalization_method: result.matchMethod,
        canonicalized_at: now,
      });
      if (result.status === 'RESOLVED') resolved += 1;
      else unresolved += 1;
    }

    // Canonical interval-union supported-years projection (§19).
    const usage = await this.evidence.listCanonicalUsageForTalent({
      tenant_id: tenantId,
      talent_id: talentId,
    });
    const canonicalRows: CanonicalUsageRow[] = [];
    for (const u of usage) {
      if (u.canonical_skill_id === null) continue;
      canonicalRows.push({
        canonicalSkillId: u.canonical_skill_id,
        usageStart: u.usage_start,
        usageEnd: u.usage_end,
      });
    }
    const canonicalYears = aggregateCanonicalYears(canonicalRows);

    // Attach to the latest existing derived snapshot; never fabricate one.
    let snapshotUpdated = false;
    const snapshot = await this.evidence.findLatestDerivedSnapshot({
      tenant_id: tenantId,
      talent_id: talentId,
    });
    if (snapshot !== null) {
      await this.evidence.updateDerivedSnapshotCanonicalYears(snapshot.id, canonicalYears);
      snapshotUpdated = true;
    }

    return {
      tenant_id: tenantId,
      talent_id: talentId,
      total: rows.length,
      resolved,
      unresolved,
      canonical_skill_count: Object.keys(canonicalYears).length,
      snapshot_updated: snapshotUpdated,
    };
  }
}
