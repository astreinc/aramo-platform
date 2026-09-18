import { apiClient } from '@aramo/fe-foundation';

// SKILL-TAX-1F-C1 — typed client for the platform skill-governance surface
// (/platform/skills*). Edge-routed to apps/api (:3000 dev, api:3000 prod) — see
// vite.config / nginx. Rides the shared HttpOnly platform session cookie via
// apiClient. This client covers ONLY the Registry contract (B2 mutations + B3 detail
// reads). The review-queue and proposal surfaces are 1F-C2 and are intentionally
// absent here.

export type SkillStatus = 'active' | 'inactive';
export type SkillAliasType =
  | 'ABBREVIATION'
  | 'COMMON_NAME'
  | 'LEGACY_NAME'
  | 'VENDOR_VARIANT'
  | 'SPELLING_VARIANT';
export type SkillRelationshipType =
  | 'RELATED_TO'
  | 'COMPATIBLE_WITH'
  | 'PARENT_OF'
  | 'BUILT_ON'
  | 'REQUIRES'
  | 'SUPERSEDES';
export type SkillRelationshipSource =
  | 'VENDOR_DOC'
  | 'ADMIN_CURATED'
  | 'IMPORTED_TAXONOMY'
  | 'AI_RECOMMENDED';

export const ALIAS_TYPES: readonly SkillAliasType[] = [
  'ABBREVIATION',
  'COMMON_NAME',
  'LEGACY_NAME',
  'VENDOR_VARIANT',
  'SPELLING_VARIANT',
];
export const RELATIONSHIP_TYPES: readonly SkillRelationshipType[] = [
  'RELATED_TO',
  'COMPATIBLE_WITH',
  'PARENT_OF',
  'BUILT_ON',
  'REQUIRES',
  'SUPERSEDES',
];
export const RELATIONSHIP_SOURCES: readonly SkillRelationshipSource[] = [
  'VENDOR_DOC',
  'ADMIN_CURATED',
  'IMPORTED_TAXONOMY',
  'AI_RECOMMENDED',
];

export interface Skill {
  id: string;
  canonical_name: string;
  normalized_name: string;
  description: string | null;
  status: SkillStatus;
  merged_into_skill_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillAlias {
  id: string;
  skill_id: string;
  alias: string;
  normalized_alias: string;
  alias_type: SkillAliasType;
  status: SkillStatus;
}

export interface SkillVersion {
  id: string;
  skill_id: string;
  version: string;
  normalized_version: string;
  version_family: string | null;
  status: SkillStatus;
}

export interface SkillRelationship {
  id: string;
  source_skill_id: string;
  target_skill_id: string;
  relationship_type: SkillRelationshipType;
  directionality: 'DIRECTED' | 'SYMMETRIC';
  status: SkillStatus;
  source: SkillRelationshipSource;
  source_ref: string | null;
}

export const skillsApi = {
  // ---- Reads (platform:skill:read) --------------------------------------
  listSkills(params?: { includeInactive?: boolean }): Promise<{ skills: Skill[] }> {
    const suffix = params?.includeInactive ? '?include_inactive=true' : '';
    return apiClient.get(`/platform/skills${suffix}`);
  },
  getSkill(id: string): Promise<Skill> {
    return apiClient.get(`/platform/skills/${id}`);
  },
  listAliases(id: string, params?: { includeInactive?: boolean }): Promise<{ aliases: SkillAlias[] }> {
    const suffix = params?.includeInactive ? '?include_inactive=true' : '';
    return apiClient.get(`/platform/skills/${id}/aliases${suffix}`);
  },
  listVersions(id: string): Promise<{ versions: SkillVersion[] }> {
    return apiClient.get(`/platform/skills/${id}/versions`);
  },
  listRelationships(id: string): Promise<{ relationships: SkillRelationship[] }> {
    return apiClient.get(`/platform/skills/${id}/relationships`);
  },

  // ---- Registry mutations (platform:skill:manage) -----------------------
  createSkill(body: { canonical_name: string; description?: string | null }): Promise<Skill> {
    return apiClient.post('/platform/skills', body);
  },
  updateSkill(
    id: string,
    body: { canonical_name?: string; description?: string | null },
  ): Promise<Skill> {
    return apiClient.patch(`/platform/skills/${id}`, body);
  },
  deactivateSkill(id: string): Promise<Skill> {
    return apiClient.post(`/platform/skills/${id}/deactivate`);
  },
  reactivateSkill(id: string): Promise<Skill> {
    return apiClient.post(`/platform/skills/${id}/reactivate`);
  },
  mergeSkill(loserId: string, body: { winner_skill_id: string }): Promise<Skill> {
    return apiClient.post(`/platform/skills/${loserId}/merge`, body);
  },
  overrideSkill(
    id: string,
    body: { surface_form?: string | null; reason?: string | null },
  ): Promise<{ ok: true }> {
    return apiClient.post(`/platform/skills/${id}/override`, body);
  },
  addAlias(id: string, body: { alias: string; alias_type: SkillAliasType }): Promise<SkillAlias> {
    return apiClient.post(`/platform/skills/${id}/aliases`, body);
  },
  removeAlias(id: string, aliasId: string): Promise<SkillAlias> {
    return apiClient.delete(`/platform/skills/${id}/aliases/${aliasId}`);
  },
  addVersion(
    id: string,
    body: { version: string; version_family?: string | null },
  ): Promise<SkillVersion> {
    return apiClient.post(`/platform/skills/${id}/versions`, body);
  },
  updateVersion(
    id: string,
    versionId: string,
    body: { version_family?: string | null; status?: SkillStatus },
  ): Promise<SkillVersion> {
    return apiClient.patch(`/platform/skills/${id}/versions/${versionId}`, body);
  },
  addRelationship(
    id: string,
    body: {
      target_skill_id: string;
      relationship_type: SkillRelationshipType;
      source: SkillRelationshipSource;
      source_ref?: string | null;
    },
  ): Promise<SkillRelationship> {
    return apiClient.post(`/platform/skills/${id}/relationships`, body);
  },
  removeRelationship(id: string, relationshipId: string): Promise<SkillRelationship> {
    return apiClient.delete(`/platform/skills/${id}/relationships/${relationshipId}`);
  },
};
