import { vi } from 'vitest';

import { skillsApi, type Proposal, type Skill, type SkillAlias, type SkillRelationship, type SkillVersion } from './skills-api';

// PLATFORM-UX-1 F-7 test fixtures — real enum values only (directive R-9).

export function skill(id: string, name: string, over: Partial<Skill> = {}): Skill {
  return {
    id,
    canonical_name: name,
    normalized_name: name.toLowerCase(),
    description: null,
    status: 'active',
    merged_into_skill_id: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-10-12T00:00:00.000Z',
    ...over,
  };
}

export const KUBE = skill('s-kube', 'Kubernetes');
export const DOCKER = skill('s-dock', 'Docker');
export const TERRA = skill('s-terr', 'Terraform');
export const PAYROLL = skill('s-payr', 'Payroll processing', { status: 'inactive' });
export const ALL_SKILLS: Skill[] = [KUBE, DOCKER, TERRA, PAYROLL];

export const K8S: SkillAlias = {
  id: 'a-k8s', skill_id: 's-kube', alias: 'K8s', normalized_alias: 'k8s', alias_type: 'ABBREVIATION', status: 'active',
};
export const V129: SkillVersion = {
  id: 'v-129', skill_id: 's-kube', version: '1.29', normalized_version: '1.29', version_family: 'kubernetes', status: 'active',
};
export const REQUIRES_DOCKER: SkillRelationship = {
  id: 'r-1', source_skill_id: 's-kube', target_skill_id: 's-dock', relationship_type: 'REQUIRES',
  directionality: 'DIRECTED', status: 'active', source: 'ADMIN_CURATED', source_ref: 'taxonomy-v4',
};
export const TERRA_BUILT_ON_KUBE: SkillRelationship = {
  id: 'r-2', source_skill_id: 's-terr', target_skill_id: 's-kube', relationship_type: 'BUILT_ON',
  directionality: 'DIRECTED', status: 'active', source: 'AI_RECOMMENDED', source_ref: null,
};

export function proposal(id: string, over: Partial<Proposal> = {}): Proposal {
  return {
    id,
    proposal_type: 'ALIAS',
    source: 'AI_RECOMMENDED',
    status: 'PENDING',
    payload: { skill_id: 's-kube', alias: 'k8s admin', alias_type: 'COMMON_NAME' },
    proposed_by: null,
    proposed_at: '2026-10-22T00:00:00.000Z',
    decided_by: null,
    decided_at: null,
    decision_reason: null,
    applied_entity_id: null,
    ...over,
  };
}

/** The registry list every screen loads to resolve names. */
export function mockDirectory(skills: Skill[] = ALL_SKILLS) {
  return vi.spyOn(skillsApi, 'listSkills').mockResolvedValue({ skills });
}
