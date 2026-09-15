// Governed SkillRelationship vocabulary (SKILL-TAX-1C). Closed TS unions kept
// byte-aligned with the DB CHECK constraints in the 20260915160000
// migration. IS_ALIAS_OF / IS_VERSION_OF are deliberately ABSENT — those
// semantics belong to SkillAlias / SkillVersion (§9: do not duplicate them
// here). BELONGS_TO_CATEGORY is also absent until the category model exists.

export type SkillRelationshipType =
  | 'RELATED_TO'
  | 'COMPATIBLE_WITH'
  | 'PARENT_OF'
  | 'BUILT_ON'
  | 'REQUIRES'
  | 'SUPERSEDES';

export type RelationshipDirectionality = 'DIRECTED' | 'SYMMETRIC';

// Provenance (§32) — a relationship edge is never an unexplained truth.
export type SkillRelationshipSource =
  | 'VENDOR_DOC'
  | 'ADMIN_CURATED'
  | 'IMPORTED_TAXONOMY'
  | 'AI_RECOMMENDED';

const SYMMETRIC_TYPES: ReadonlySet<SkillRelationshipType> = new Set([
  'RELATED_TO',
  'COMPATIBLE_WITH',
]);

export function isSymmetric(type: SkillRelationshipType): boolean {
  return SYMMETRIC_TYPES.has(type);
}

// Directionality is DERIVED from the type (§33) and then stored, so a reader
// never has to re-derive it.
export function directionalityOf(type: SkillRelationshipType): RelationshipDirectionality {
  return isSymmetric(type) ? 'SYMMETRIC' : 'DIRECTED';
}
