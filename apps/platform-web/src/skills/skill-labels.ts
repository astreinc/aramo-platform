import type { PillSpec } from '../components';

import type {
  ProposalStatus,
  ProposalType,
  ReviewQueueSourceDomain,
  SkillAliasType,
  SkillRelationship,
  SkillRelationshipSource,
  SkillRelationshipType,
  SkillStatus,
} from './skills-api';

// PLATFORM-UX-1 F-7 (directive R-9, amendment 7) — the human labels for the
// REAL skill enums. The design file's invented values (Synonym / Misspelling /
// Colloquial / Translation; Part of / Broader than / Narrower than /
// Alternative to; Curated / AI proposal / Import / Tenant signal; Current /
// Supported / Legacy) are NOT used: the real enums win, each change is a typed
// divergence in the Gate-5 report. The raw code renders secondary in mono.

export const ALIAS_TYPE_LABEL: Readonly<Record<SkillAliasType, string>> = {
  ABBREVIATION: 'Abbreviation',
  COMMON_NAME: 'Common name',
  LEGACY_NAME: 'Legacy name',
  VENDOR_VARIANT: 'Vendor variant',
  SPELLING_VARIANT: 'Spelling variant',
};

export const RELATIONSHIP_TYPE_LABEL: Readonly<Record<SkillRelationshipType, string>> = {
  RELATED_TO: 'Related to',
  COMPATIBLE_WITH: 'Compatible with',
  PARENT_OF: 'Parent of',
  BUILT_ON: 'Built on',
  REQUIRES: 'Requires',
  SUPERSEDES: 'Supersedes',
};

export const RELATIONSHIP_SOURCE_LABEL: Readonly<Record<SkillRelationshipSource, string>> = {
  VENDOR_DOC: 'Vendor documentation',
  ADMIN_CURATED: 'Admin curated',
  IMPORTED_TAXONOMY: 'Imported taxonomy',
  AI_RECOMMENDED: 'AI recommended',
};

/**
 * The relationship types the server stores as SYMMETRIC
 * (libs/skills-taxonomy relationship-vocab.ts). Used ONLY to label the type
 * options before an edge exists; a stored edge's direction always comes from
 * the server's `directionality` field.
 */
export const SYMMETRIC_RELATIONSHIP_TYPES: ReadonlySet<SkillRelationshipType> = new Set<SkillRelationshipType>([
  'RELATED_TO',
  'COMPATIBLE_WITH',
]);

export const DOMAIN_LABEL: Readonly<Record<ReviewQueueSourceDomain, string>> = {
  talent: 'Talent',
  requisition: 'Requisition',
};

export const PROPOSAL_TYPE_LABEL: Readonly<Record<ProposalType, string>> = {
  ALIAS: 'Alias',
  RELATIONSHIP: 'Relationship',
};

/** A known code's label; an unknown code renders as itself. */
function labelOf(map: Readonly<Record<string, string>>, code: string): string {
  return map[code] ?? code;
}

export const aliasTypeLabel = (code: string): string => labelOf(ALIAS_TYPE_LABEL, code);
export const relationshipTypeLabel = (code: string): string => labelOf(RELATIONSHIP_TYPE_LABEL, code);
export const relationshipSourceLabel = (code: string): string => labelOf(RELATIONSHIP_SOURCE_LABEL, code);
export const proposalTypeLabel = (code: string): string => labelOf(PROPOSAL_TYPE_LABEL, code);

/** "↔ Symmetric" / "→ Directed" — from the server's directionality. */
export function directionLabel(directionality: SkillRelationship['directionality']): string {
  return directionality === 'SYMMETRIC' ? '↔ Symmetric' : '→ Directed';
}

/** Skill, alias and version status (Active / Inactive). */
export function statusPill(status: SkillStatus | string): PillSpec {
  return status === 'active' ? { label: 'Active', tone: 'ok' } : { label: 'Inactive', tone: 'muted' };
}

export const PROPOSAL_STATUS_PILL: Readonly<Record<ProposalStatus, PillSpec>> = {
  PENDING: { label: 'Pending', tone: 'info' },
  ACCEPTED: { label: 'Accepted', tone: 'ok' },
  REJECTED: { label: 'Rejected', tone: 'muted' },
};

export function proposalStatusPill(status: string): PillSpec {
  return (PROPOSAL_STATUS_PILL as Readonly<Record<string, PillSpec>>)[status] ?? { label: status, tone: 'neutral' };
}
