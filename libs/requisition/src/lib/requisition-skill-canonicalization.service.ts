import { Injectable } from '@nestjs/common';
import { JobDomainRepository, goldenProfileContentFromStorage } from '@aramo/job-domain';
import { SkillCanonicalizationService } from '@aramo/skills-taxonomy';

import {
  RequisitionSkillRequirementRepository,
  type RequirementType,
} from './requisition-skill-requirement.repository.js';

// SKILL-TAX-1D — RequisitionSkillCanonicalizationService. A requisition-side,
// re-runnable worker that DERIVES the typed canonical requirement rows from the
// authored GoldenProfile skills and resolves each surface form through
// skills-taxonomy's READ-ONLY SkillCanonicalizationService (the requisition
// module legally imports scope:cip; job-domain does NOT — resolution lives here).
//
// GoldenProfile stays the authored source of truth (never written). Each run
// deterministically reconciles the derived rows against the current authored
// skills: authored-and-present rows are (re-)resolved in place, newly-authored
// skills are created, and de-authored rows are removed. Because it re-resolves
// every present row each run, an UNRESOLVED requirement self-heals to RESOLVED
// once an alias/version/merge lands in the taxonomy. Idempotent on unchanged
// input + taxonomy. It NEVER infers a version (GoldenProfile carries none) and
// NEVER touches matching authority — the authoritative name-keyed matcher does
// not read these rows.

export interface ReconcileRequisitionResult {
  tenant_id: string;
  requisition_id: string;
  golden_profile_id: string;
  total: number;
  resolved: number;
  unresolved: number;
  created: number;
  updated: number;
  deleted: number;
}

interface DesiredRequirement {
  requirement_type: RequirementType;
  raw_surface_form: string;
}

// Natural-key string. requirement_type is a closed enum and authored skill names
// carry no newline, so '\n' is a safe, collision-free join delimiter.
const keyOf = (d: DesiredRequirement): string =>
  `${d.requirement_type}\n${d.raw_surface_form}`;

@Injectable()
export class RequisitionSkillCanonicalizationService {
  constructor(
    private readonly requirements: RequisitionSkillRequirementRepository,
    private readonly jobDomain: JobDomainRepository,
    private readonly canonicalization: SkillCanonicalizationService,
  ) {}

  // The caller (confirm-flow trigger or a batch orchestrator) supplies the
  // requisition's confirmed golden_profile_id — the worker does not need the
  // Requisition row itself. Use RequisitionSkillRequirementRepository
  // .findGoldenProfileIdForRequisition to resolve it when only the requisition id
  // is known.
  async reconcileGoldenProfile(
    tenantId: string,
    requisitionId: string,
    goldenProfileId: string,
  ): Promise<ReconcileRequisitionResult> {
    const desired = await this.buildDesired(tenantId, goldenProfileId);
    const existing = await this.requirements.listForGoldenProfile(tenantId, goldenProfileId);

    const desiredByKey = new Map<string, DesiredRequirement>();
    for (const d of desired) desiredByKey.set(keyOf(d), d); // dedup by natural key
    const existingByKey = new Map(existing.map((r) => [keyOf(r), r]));

    const now = new Date();
    let resolved = 0;
    let unresolved = 0;
    let created = 0;
    let updated = 0;
    let deleted = 0;

    for (const [k, d] of desiredByKey) {
      // Read-only resolution. No authored version on GoldenProfile -> no version
      // is ever passed, so canonical_version_id can never be inferred.
      const result = await this.canonicalization.resolve({
        surfaceForm: d.raw_surface_form,
        explicitVersion: null,
      });
      if (result.status === 'RESOLVED') resolved += 1;
      else unresolved += 1;

      const canon = {
        canonical_skill_id: result.canonicalSkillId,
        canonical_version_id: result.canonicalVersionId,
        canonicalization_status: result.status,
        canonicalization_method: result.matchMethod,
        canonicalized_at: now,
      };

      const ex = existingByKey.get(k);
      if (ex !== undefined) {
        await this.requirements.updateCanonical(ex.id, canon);
        updated += 1;
      } else {
        await this.requirements.create({
          tenant_id: tenantId,
          requisition_id: requisitionId,
          golden_profile_id: goldenProfileId,
          requirement_type: d.requirement_type,
          raw_surface_form: d.raw_surface_form,
          version_requirement: null,
          ...canon,
        });
        created += 1;
      }
    }

    // De-authored rows: present in the DB but no longer authored on GoldenProfile.
    for (const [k, ex] of existingByKey) {
      if (!desiredByKey.has(k)) {
        await this.requirements.deleteById(ex.id);
        deleted += 1;
      }
    }

    return {
      tenant_id: tenantId,
      requisition_id: requisitionId,
      golden_profile_id: goldenProfileId,
      total: desiredByKey.size,
      resolved,
      unresolved,
      created,
      updated,
      deleted,
    };
  }

  // Extract the authored skills from the GoldenProfile content as the desired
  // requirement set. Tenant-guarded; surface text preserved (trimmed), empties
  // dropped, deduped by (requirement_type, surface form).
  private async buildDesired(
    tenantId: string,
    goldenProfileId: string,
  ): Promise<DesiredRequirement[]> {
    const gp = await this.jobDomain.findGoldenProfileById(goldenProfileId);
    if (gp === null || gp.tenant_id !== tenantId) return [];

    const content = goldenProfileContentFromStorage({
      skills: gp.skills,
      experience: gp.experience,
      constraints: gp.constraints,
    });

    const out: DesiredRequirement[] = [];
    const add = (requirement_type: RequirementType, name: string | undefined): void => {
      const raw = (name ?? '').trim();
      if (raw.length > 0) out.push({ requirement_type, raw_surface_form: raw });
    };
    for (const s of content.required_skills) add('required', s.name);
    for (const s of content.preferred_skills) add('preferred', s.name);
    for (const s of content.critical_skills) add('critical', s.name);
    return out;
  }
}
