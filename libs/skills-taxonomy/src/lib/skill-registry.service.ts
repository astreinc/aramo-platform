import { Injectable } from '@nestjs/common';

import { normalizeSkillName, normalizeVersion } from './normalize-skill-name.js';
import { isNotFound, uniqueViolationOn } from './prisma-error.js';
import { SkillRepository, type SkillActor, type SkillRow } from './skill.repository.js';
import {
  SkillAliasRepository,
  type SkillAliasRow,
  type SkillAliasType,
} from './skill-alias.repository.js';
import {
  SkillVersionRepository,
  type SkillVersionRow,
} from './skill-version.repository.js';
import {
  SkillRelationshipRepository,
  type SkillRelationshipRow,
} from './skill-relationship.repository.js';
import {
  directionalityOf,
  isSymmetric,
  type SkillRelationshipSource,
  type SkillRelationshipType,
} from './relationship-vocab.js';

// SkillRegistryService — the public, internal-only surface for the canonical
// Skill registry + governed aliases + versions (SKILL-TAX-1A/1B). Owns
// normalization, uniqueness-conflict translation, lifecycle rules and
// validation; delegates persistence + audit to the repositories. NO HTTP/REST
// endpoint, NO permission scope, NO admin UI (those are 1F). The 1C
// canonicalization engine consumes this service in-process.
//
// Invariants: canonical identity is opaque + additive (never re-keys the legacy
// TalentSkillEvidence.skill_id); normalized_name is the load-bearing uniqueness
// authority; the registry is platform-global; a version/alias is only ever what
// the caller states — nothing is inferred.

export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillValidationError';
  }
}

export class SkillNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Skill not found: ${id}`);
    this.name = 'SkillNotFoundError';
  }
}

export class SkillConflictError extends Error {
  constructor(
    public readonly constraint: 'normalized_name' | 'canonical_name',
    public readonly value: string,
  ) {
    super(`Skill conflict on ${constraint}: "${value}"`);
    this.name = 'SkillConflictError';
  }
}

export class SkillAliasConflictError extends Error {
  constructor(public readonly normalizedAlias: string) {
    super(`Skill alias conflict on normalized_alias: "${normalizedAlias}"`);
    this.name = 'SkillAliasConflictError';
  }
}

export class SkillVersionConflictError extends Error {
  constructor(
    public readonly skillId: string,
    public readonly normalizedVersion: string,
  ) {
    super(`Skill version conflict on (${skillId}, "${normalizedVersion}")`);
    this.name = 'SkillVersionConflictError';
  }
}

export class SkillRelationshipConflictError extends Error {
  constructor(
    public readonly sourceSkillId: string,
    public readonly targetSkillId: string,
    public readonly relationshipType: SkillRelationshipType,
  ) {
    super(
      `Skill relationship conflict on (${sourceSkillId}, ${targetSkillId}, ${relationshipType})`,
    );
    this.name = 'SkillRelationshipConflictError';
  }
}

export interface CreateSkillInput {
  canonicalName: string;
  description?: string | null;
  actor?: SkillActor;
}

export interface UpdateSkillInput {
  canonicalName?: string;
  description?: string | null;
  actor?: SkillActor;
}

export interface AddAliasInput {
  skillId: string;
  alias: string;
  aliasType: SkillAliasType;
  actor?: SkillActor;
}

export interface AddVersionInput {
  skillId: string;
  version: string;
  versionFamily?: string | null;
  actor?: SkillActor;
}

export interface AddRelationshipInput {
  sourceSkillId: string;
  targetSkillId: string;
  relationshipType: SkillRelationshipType;
  source: SkillRelationshipSource;
  sourceRef?: string | null;
  actor?: SkillActor;
}

@Injectable()
export class SkillRegistryService {
  constructor(
    private readonly skills: SkillRepository,
    private readonly aliases: SkillAliasRepository,
    private readonly versions: SkillVersionRepository,
    private readonly relationships: SkillRelationshipRepository,
  ) {}

  // ---- Canonical Skill (1A) ---------------------------------------------

  async createSkill(input: CreateSkillInput): Promise<SkillRow> {
    const canonicalName = input.canonicalName.trim();
    if (canonicalName.length === 0) {
      throw new SkillValidationError('canonical_name must be a non-empty string');
    }
    const normalizedName = normalizeSkillName(canonicalName);
    try {
      return await this.skills.createSkill({
        canonical_name: canonicalName,
        normalized_name: normalizedName,
        description: input.description ?? null,
        actor: input.actor,
      });
    } catch (e) {
      if (uniqueViolationOn(e, 'normalized_name')) {
        throw new SkillConflictError('normalized_name', normalizedName);
      }
      if (uniqueViolationOn(e, 'canonical_name')) {
        throw new SkillConflictError('canonical_name', canonicalName);
      }
      throw e;
    }
  }

  async updateSkill(id: string, input: UpdateSkillInput): Promise<SkillRow> {
    const persist: {
      canonical_name?: string;
      normalized_name?: string;
      description?: string | null;
      actor?: SkillActor;
    } = { actor: input.actor };

    let normalizedName: string | undefined;
    if (input.canonicalName !== undefined) {
      const canonicalName = input.canonicalName.trim();
      if (canonicalName.length === 0) {
        throw new SkillValidationError('canonical_name must be a non-empty string');
      }
      normalizedName = normalizeSkillName(canonicalName);
      persist.canonical_name = canonicalName;
      persist.normalized_name = normalizedName;
    }
    if (input.description !== undefined) persist.description = input.description;

    try {
      return await this.skills.updateSkill(id, persist);
    } catch (e) {
      if (isNotFound(e)) throw new SkillNotFoundError(id);
      if (uniqueViolationOn(e, 'normalized_name')) {
        throw new SkillConflictError('normalized_name', normalizedName ?? '');
      }
      if (uniqueViolationOn(e, 'canonical_name')) {
        throw new SkillConflictError('canonical_name', persist.canonical_name ?? '');
      }
      throw e;
    }
  }

  async deactivateSkill(id: string, actor?: SkillActor): Promise<SkillRow> {
    try {
      return await this.skills.deactivateSkill(id, actor);
    } catch (e) {
      if (isNotFound(e)) throw new SkillNotFoundError(id);
      throw e;
    }
  }

  async reactivateSkill(id: string, actor?: SkillActor): Promise<SkillRow> {
    try {
      return await this.skills.reactivateSkill(id, actor);
    } catch (e) {
      if (isNotFound(e)) throw new SkillNotFoundError(id);
      throw e;
    }
  }

  async getSkillById(id: string): Promise<SkillRow | null> {
    return this.skills.findById(id);
  }

  // Exact canonical lookup by any surface form (normalized). A direct registry
  // lookup, NOT canonicalization inference — returns a Skill only when the
  // normalized surface form already equals a canonical/normalized name.
  async resolveBySurfaceForm(surfaceForm: string): Promise<SkillRow | null> {
    return this.skills.findByNormalizedName(normalizeSkillName(surfaceForm));
  }

  async listSkills(opts?: { includeInactive?: boolean }): Promise<SkillRow[]> {
    return this.skills.listSkills(opts);
  }

  // ---- Aliases (1B) ------------------------------------------------------

  async addAlias(input: AddAliasInput): Promise<SkillAliasRow> {
    const alias = input.alias.trim();
    if (alias.length === 0) {
      throw new SkillValidationError('alias must be a non-empty string');
    }
    const skill = await this.skills.findById(input.skillId);
    if (skill === null) throw new SkillNotFoundError(input.skillId);

    const normalizedAlias = normalizeSkillName(alias);
    try {
      return await this.aliases.addAlias({
        skill_id: input.skillId,
        alias,
        normalized_alias: normalizedAlias,
        alias_type: input.aliasType,
        actor: input.actor,
      });
    } catch (e) {
      if (uniqueViolationOn(e, 'normalized_alias')) {
        throw new SkillAliasConflictError(normalizedAlias);
      }
      throw e;
    }
  }

  async removeAlias(id: string, actor?: SkillActor): Promise<SkillAliasRow> {
    try {
      return await this.aliases.removeAlias(id, actor);
    } catch (e) {
      if (isNotFound(e)) throw new SkillNotFoundError(id);
      throw e;
    }
  }

  // Direct alias lookup by surface form (normalized). A building block for the
  // 1C canonicalization engine — it does NOT itself decide precedence between a
  // canonical-name match and an alias match.
  async findAliasBySurfaceForm(surfaceForm: string): Promise<SkillAliasRow | null> {
    return this.aliases.findByNormalizedAlias(normalizeSkillName(surfaceForm));
  }

  async listAliases(
    skillId: string,
    opts?: { includeInactive?: boolean },
  ): Promise<SkillAliasRow[]> {
    return this.aliases.listForSkill(skillId, opts);
  }

  // ---- Versions (1B) -----------------------------------------------------

  async addVersion(input: AddVersionInput): Promise<SkillVersionRow> {
    const version = input.version.trim();
    if (version.length === 0) {
      throw new SkillValidationError('version must be a non-empty string');
    }
    const skill = await this.skills.findById(input.skillId);
    if (skill === null) throw new SkillNotFoundError(input.skillId);

    const normalizedVersion = normalizeVersion(version);
    try {
      return await this.versions.addVersion({
        skill_id: input.skillId,
        version,
        normalized_version: normalizedVersion,
        version_family: input.versionFamily ?? null,
        actor: input.actor,
      });
    } catch (e) {
      if (uniqueViolationOn(e, 'normalized_version')) {
        throw new SkillVersionConflictError(input.skillId, normalizedVersion);
      }
      throw e;
    }
  }

  async updateVersion(
    id: string,
    input: { versionFamily?: string | null; status?: 'active' | 'inactive'; actor?: SkillActor },
  ): Promise<SkillVersionRow> {
    try {
      return await this.versions.updateVersion(id, {
        version_family: input.versionFamily,
        status: input.status,
        actor: input.actor,
      });
    } catch (e) {
      if (isNotFound(e)) throw new SkillNotFoundError(id);
      throw e;
    }
  }

  async findVersion(skillId: string, version: string): Promise<SkillVersionRow | null> {
    return this.versions.findForSkill(skillId, normalizeVersion(version));
  }

  async listVersions(skillId: string): Promise<SkillVersionRow[]> {
    return this.versions.listForSkill(skillId);
  }

  // ---- Relationships (1C) ------------------------------------------------

  async addRelationship(input: AddRelationshipInput): Promise<SkillRelationshipRow> {
    if (input.sourceSkillId === input.targetSkillId) {
      throw new SkillValidationError('a skill cannot have a relationship to itself');
    }
    const [source, target] = await Promise.all([
      this.skills.findById(input.sourceSkillId),
      this.skills.findById(input.targetSkillId),
    ]);
    if (source === null) throw new SkillNotFoundError(input.sourceSkillId);
    if (target === null) throw new SkillNotFoundError(input.targetSkillId);

    const directionality = directionalityOf(input.relationshipType);
    // Symmetric edges are stored in a single canonical orientation (smaller
    // uuid as source) so A~B and B~A do not become accidental duplicates (§34).
    let sourceSkillId = input.sourceSkillId;
    let targetSkillId = input.targetSkillId;
    if (isSymmetric(input.relationshipType) && sourceSkillId > targetSkillId) {
      [sourceSkillId, targetSkillId] = [targetSkillId, sourceSkillId];
    }

    try {
      return await this.relationships.addRelationship({
        source_skill_id: sourceSkillId,
        target_skill_id: targetSkillId,
        relationship_type: input.relationshipType,
        directionality,
        source: input.source,
        source_ref: input.sourceRef ?? null,
        actor: input.actor,
      });
    } catch (e) {
      if (uniqueViolationOn(e, 'source_target_type')) {
        throw new SkillRelationshipConflictError(
          sourceSkillId,
          targetSkillId,
          input.relationshipType,
        );
      }
      throw e;
    }
  }

  async removeRelationship(id: string, actor?: SkillActor): Promise<SkillRelationshipRow> {
    try {
      return await this.relationships.removeRelationship(id, actor);
    } catch (e) {
      if (isNotFound(e)) throw new SkillNotFoundError(id);
      throw e;
    }
  }

  async listRelationships(skillId: string): Promise<SkillRelationshipRow[]> {
    return this.relationships.listForSkill(skillId);
  }
}
