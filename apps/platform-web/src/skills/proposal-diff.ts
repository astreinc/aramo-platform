import type { DiffRow } from '../components';

import {
  ALIAS_TYPES,
  RELATIONSHIP_TYPES,
  type Proposal,
  type SkillAlias,
  type SkillAliasType,
  type SkillRelationship,
  type SkillRelationshipType,
} from './skills-api';
import { aliasTypeLabel, relationshipTypeLabel, SYMMETRIC_RELATIONSHIP_TYPES } from './skill-labels';
import type { SkillDirectory } from './skill-directory';
import { skillNameText } from './SkillName';

// PLATFORM-UX-1 F-7 — a proposal's change as a HUMAN diff (handoff §9
// Proposals: existing rows plain, the proposed row "+"), never raw JSON. The
// payload shape is the one SkillGovernanceService validates at accept time:
//   ALIAS        { alias, skill_id, alias_type }
//   RELATIONSHIP { source_skill_id, target_skill_id, relationship_type, source, source_ref? }
// A payload that doesn't parse renders the plain "can't be read" copy.

export type ParsedProposal =
  | { readonly kind: 'ALIAS'; readonly alias: string; readonly skillId: string; readonly aliasType: SkillAliasType }
  | {
      readonly kind: 'RELATIONSHIP';
      readonly sourceId: string;
      readonly targetId: string;
      readonly relType: SkillRelationshipType;
    }
  | { readonly kind: 'INVALID' };

function str(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

export function parseProposal(p: Proposal): ParsedProposal {
  const o = p.payload !== null && typeof p.payload === 'object' ? (p.payload as Record<string, unknown>) : {};
  if (p.proposal_type === 'ALIAS') {
    const alias = str(o, 'alias');
    const skillId = str(o, 'skill_id');
    const aliasType = str(o, 'alias_type');
    if (alias && skillId && aliasType && (ALIAS_TYPES as readonly string[]).includes(aliasType)) {
      return { kind: 'ALIAS', alias: alias.trim(), skillId, aliasType: aliasType as SkillAliasType };
    }
    return { kind: 'INVALID' };
  }
  if (p.proposal_type === 'RELATIONSHIP') {
    const sourceId = str(o, 'source_skill_id');
    const targetId = str(o, 'target_skill_id');
    const relType = str(o, 'relationship_type');
    if (sourceId && targetId && relType && (RELATIONSHIP_TYPES as readonly string[]).includes(relType)) {
      return { kind: 'RELATIONSHIP', sourceId, targetId, relType: relType as SkillRelationshipType };
    }
  }
  return { kind: 'INVALID' };
}

/** The skill whose collection the proposal changes (alias owner / relationship source). */
export function proposalSubjectId(parsed: ParsedProposal): string | null {
  if (parsed.kind === 'ALIAS') return parsed.skillId;
  if (parsed.kind === 'RELATIONSHIP') return parsed.sourceId;
  return null;
}

/** The list row's one-line summary: "“k8s admin” → Kubernetes" · "Python ↔ Data analysis". */
export function proposalSummary(p: Proposal, directory: SkillDirectory): string {
  const parsed = parseProposal(p);
  if (parsed.kind === 'ALIAS') return `“${parsed.alias}” → ${skillNameText(parsed.skillId, directory)}`;
  if (parsed.kind === 'RELATIONSHIP') {
    const arrow = SYMMETRIC_RELATIONSHIP_TYPES.has(parsed.relType) ? '↔' : '→';
    return `${skillNameText(parsed.sourceId, directory)} ${arrow} ${skillNameText(parsed.targetId, directory)}`;
  }
  return p.proposal_type === 'ALIAS' ? 'Alias proposal' : 'Relationship proposal';
}

/** "Aliases of Kubernetes" / "Relationships of Python". */
export function diffTitle(parsed: ParsedProposal, directory: SkillDirectory): string {
  if (parsed.kind === 'ALIAS') return `Aliases of ${skillNameText(parsed.skillId, directory)}`;
  if (parsed.kind === 'RELATIONSHIP') return `Relationships of ${skillNameText(parsed.sourceId, directory)}`;
  return 'Proposed change';
}

/**
 * Existing rows plain, then the proposed row "+". An accepted proposal's
 * applied row (applied_entity_id) is left out of the existing rows so the
 * change isn't listed twice.
 */
export function buildProposalDiff(
  p: Proposal,
  parsed: ParsedProposal,
  existing: { readonly aliases?: readonly SkillAlias[]; readonly relationships?: readonly SkillRelationship[] },
  directory: SkillDirectory,
): DiffRow[] {
  const applied = p.applied_entity_id;
  if (parsed.kind === 'ALIAS') {
    const rows: DiffRow[] = (existing.aliases ?? [])
      .filter((a) => a.status === 'active' && a.id !== applied)
      .map((a) => ({ key: a.id, kind: 'same', text: a.alias, sub: aliasTypeLabel(a.alias_type) }));
    rows.push({ key: 'proposed', kind: 'added', text: parsed.alias, sub: aliasTypeLabel(parsed.aliasType) });
    return rows;
  }
  if (parsed.kind === 'RELATIONSHIP') {
    const rows: DiffRow[] = (existing.relationships ?? [])
      .filter((r) => r.status === 'active' && r.id !== applied)
      .map((r) => {
        const other = r.source_skill_id === parsed.sourceId ? r.target_skill_id : r.source_skill_id;
        return {
          key: r.id,
          kind: 'same',
          text: skillNameText(other, directory),
          sub: relationshipTypeLabel(r.relationship_type),
        };
      });
    rows.push({
      key: 'proposed',
      kind: 'added',
      text: skillNameText(parsed.targetId, directory),
      sub: `${relationshipTypeLabel(parsed.relType)} · ${SYMMETRIC_RELATIONSHIP_TYPES.has(parsed.relType) ? 'symmetric' : 'directed'}`,
    });
    return rows;
  }
  return [];
}
