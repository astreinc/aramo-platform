import { apiClient } from '@aramo/fe-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { skillsApi } from './skills-api';

// SKILL-TAX-1F-C1 — the skills governance client rides apiClient (cookie auth). These
// assert the exact method + path (+ include_inactive) for every registry call the
// console makes, so a contract drift (path/verb) is caught in the FE unit lane.
describe('skillsApi', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads hit the correct GET paths', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({} as never);
    await skillsApi.listSkills();
    await skillsApi.listSkills({ includeInactive: true });
    await skillsApi.getSkill('s1');
    await skillsApi.listAliases('s1');
    await skillsApi.listAliases('s1', { includeInactive: true });
    await skillsApi.listVersions('s1');
    await skillsApi.listRelationships('s1');
    const paths = get.mock.calls.map((c) => c[0]);
    expect(paths).toEqual([
      '/platform/skills',
      '/platform/skills?include_inactive=true',
      '/platform/skills/s1',
      '/platform/skills/s1/aliases',
      '/platform/skills/s1/aliases?include_inactive=true',
      '/platform/skills/s1/versions',
      '/platform/skills/s1/relationships',
    ]);
  });

  it('mutations hit the correct verbs + paths', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({} as never);
    const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue({} as never);
    const del = vi.spyOn(apiClient, 'delete').mockResolvedValue({} as never);

    await skillsApi.createSkill({ canonical_name: 'K' });
    await skillsApi.updateSkill('s1', { canonical_name: 'K2' });
    await skillsApi.deactivateSkill('s1');
    await skillsApi.reactivateSkill('s1');
    await skillsApi.mergeSkill('loser', { winner_skill_id: 'winner' });
    await skillsApi.overrideSkill('s1', { reason: 'r' });
    await skillsApi.addAlias('s1', { alias: 'K8s', alias_type: 'ABBREVIATION' });
    await skillsApi.removeAlias('s1', 'a1');
    await skillsApi.addVersion('s1', { version: '1.0' });
    await skillsApi.updateVersion('s1', 'v1', { status: 'inactive' });
    await skillsApi.addRelationship('s1', {
      target_skill_id: 's2',
      relationship_type: 'BUILT_ON',
      source: 'ADMIN_CURATED',
    });
    await skillsApi.removeRelationship('s1', 'r1');

    expect(post.mock.calls.map((c) => c[0])).toEqual([
      '/platform/skills',
      '/platform/skills/s1/deactivate',
      '/platform/skills/s1/reactivate',
      '/platform/skills/loser/merge',
      '/platform/skills/s1/override',
      '/platform/skills/s1/aliases',
      '/platform/skills/s1/versions',
      '/platform/skills/s1/relationships',
    ]);
    expect(patch.mock.calls.map((c) => c[0])).toEqual([
      '/platform/skills/s1',
      '/platform/skills/s1/versions/v1',
    ]);
    expect(del.mock.calls.map((c) => c[0])).toEqual([
      '/platform/skills/s1/aliases/a1',
      '/platform/skills/s1/relationships/r1',
    ]);
  });
});
