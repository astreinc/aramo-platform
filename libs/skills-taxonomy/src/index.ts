export { SkillsTaxonomyModule } from './lib/skills-taxonomy.module.js';
export { SkillCanonicalizationProcessor } from './lib/skill-canonicalization.processor.js';
export type {
  SkillCanonicalizationScanInput,
  SkillCanonicalizationScanItem,
  SkillCanonicalizationScanResult,
} from './lib/skill-canonicalization.processor.js';
export { SKILL_CANONICALIZATION_QUEUE_NAME } from './lib/skill-canonicalization.queue.constants.js';

// SKILL-TAX-1A/1B — canonical Skill registry + aliases + versions
// (internal surface; no HTTP/scope/UI).
export { PrismaService } from './lib/prisma/prisma.service.js';
export { normalizeSkillName, normalizeVersion } from './lib/normalize-skill-name.js';
export {
  SkillRepository,
  type SkillRow,
  type SkillStatus,
  type SkillActor,
  type SkillAuditEventType,
} from './lib/skill.repository.js';
// SKILL-TAX-1F-B1 — the durable correction/propagation work ledger repository.
export {
  SkillCorrectionTaskRepository,
  type SkillCorrectionTaskRow,
  type CorrectionType,
  type CorrectionStatus,
} from './lib/skill-correction-task.repository.js';
export {
  SkillAliasRepository,
  type SkillAliasRow,
  type SkillAliasType,
} from './lib/skill-alias.repository.js';
export {
  SkillVersionRepository,
  type SkillVersionRow,
} from './lib/skill-version.repository.js';
export {
  SkillRelationshipRepository,
  type SkillRelationshipRow,
} from './lib/skill-relationship.repository.js';
export {
  isSymmetric,
  directionalityOf,
  type SkillRelationshipType,
  type RelationshipDirectionality,
  type SkillRelationshipSource,
} from './lib/relationship-vocab.js';
export {
  SkillRegistryService,
  SkillValidationError,
  SkillNotFoundError,
  SkillConflictError,
  SkillAliasConflictError,
  SkillVersionConflictError,
  SkillRelationshipConflictError,
  type CreateSkillInput,
  type UpdateSkillInput,
  type AddAliasInput,
  type AddVersionInput,
  type AddRelationshipInput,
} from './lib/skill-registry.service.js';
export {
  SkillCanonicalizationService,
  type CanonicalizationInput,
  type CanonicalizationResult,
  type CanonicalizationStatus,
  type CanonicalizationMatchMethod,
} from './lib/skill-canonicalization.service.js';
