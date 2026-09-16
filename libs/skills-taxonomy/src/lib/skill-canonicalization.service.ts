import { Injectable } from '@nestjs/common';

import { normalizeSkillName, normalizeVersion } from './normalize-skill-name.js';
import { SkillRepository } from './skill.repository.js';
import { SkillAliasRepository } from './skill-alias.repository.js';
import { SkillVersionRepository } from './skill-version.repository.js';

// SkillCanonicalizationService — the deterministic-first canonicalization
// engine (SKILL-TAX-1C, §14/§15). Pure and READ-ONLY: it resolves a stated
// surface form (+ optional explicit version) to a canonical Skill/version. It
// NEVER mutates anything and NEVER infers Talent experience or related skills
// (§6/§10) — an unknown surface form resolves to UNRESOLVED, not to a guess.
//
// Resolution order (no LLM):
//   1. EXACT_CANONICAL — normalized surface == an active Skill.normalized_name
//   2. ALIAS           — normalized surface == an active SkillAlias
//   3. VERSION         — if an explicit version is given and the resolved skill
//                        has that (normalized) version, attach canonicalVersionId
// The surface form is preserved verbatim on the result.

export type CanonicalizationStatus =
  | 'RESOLVED'
  | 'UNRESOLVED'
  | 'AMBIGUOUS'
  | 'PROVISIONAL'
  | 'REJECTED';

export type CanonicalizationMatchMethod =
  | 'EXACT_CANONICAL'
  | 'NORMALIZED_CANONICAL'
  | 'ALIAS'
  | 'VERSION'
  | 'MANUAL'
  | 'PROVISIONAL';

export interface CanonicalizationInput {
  surfaceForm: string;
  explicitVersion?: string | null;
}

export interface CanonicalizationResult {
  // The stated surface form, preserved verbatim (never rewritten).
  surfaceForm: string;
  status: CanonicalizationStatus;
  canonicalSkillId: string | null;
  canonicalName: string | null;
  canonicalVersionId: string | null;
  // Whether an explicit version was stated but not found in the registry.
  versionSurface: string | null;
  matchMethod: CanonicalizationMatchMethod | null;
}

@Injectable()
export class SkillCanonicalizationService {
  constructor(
    private readonly skills: SkillRepository,
    private readonly aliases: SkillAliasRepository,
    private readonly versions: SkillVersionRepository,
  ) {}

  async resolve(input: CanonicalizationInput): Promise<CanonicalizationResult> {
    const surfaceForm = input.surfaceForm;
    const normalized = normalizeSkillName(surfaceForm);

    const unresolved: CanonicalizationResult = {
      surfaceForm,
      status: 'UNRESOLVED',
      canonicalSkillId: null,
      canonicalName: null,
      canonicalVersionId: null,
      versionSurface: input.explicitVersion ?? null,
      matchMethod: null,
    };

    if (normalized.length === 0) return unresolved;

    // 1. Exact canonical match (active only).
    let skillId: string | null = null;
    let canonicalName: string | null = null;
    let matchMethod: CanonicalizationMatchMethod | null = null;

    const canonical = await this.skills.findByNormalizedName(normalized);
    if (canonical !== null && canonical.status === 'active') {
      skillId = canonical.id;
      canonicalName = canonical.canonical_name;
      matchMethod = 'EXACT_CANONICAL';
    } else {
      // 2. Alias match (active alias -> active skill).
      const alias = await this.aliases.findByNormalizedAlias(normalized);
      if (alias !== null && alias.status === 'active') {
        const skill = await this.skills.findById(alias.skill_id);
        if (skill !== null && skill.status === 'active') {
          skillId = skill.id;
          canonicalName = skill.canonical_name;
          matchMethod = 'ALIAS';
        }
      }
    }

    if (skillId === null || canonicalName === null || matchMethod === null) {
      return unresolved;
    }

    // 3. Optional explicit version — resolved ONLY if the skill actually has it.
    let canonicalVersionId: string | null = null;
    let versionSurface: string | null = null;
    if (input.explicitVersion !== undefined && input.explicitVersion !== null) {
      const versionText = input.explicitVersion.trim();
      if (versionText.length > 0) {
        versionSurface = input.explicitVersion;
        const version = await this.versions.findForSkill(
          skillId,
          normalizeVersion(versionText),
        );
        if (version !== null && version.status === 'active') {
          canonicalVersionId = version.id;
          matchMethod = 'VERSION';
        }
      }
    }

    return {
      surfaceForm,
      status: 'RESOLVED',
      canonicalSkillId: skillId,
      canonicalName,
      canonicalVersionId,
      versionSurface,
      matchMethod,
    };
  }
}
