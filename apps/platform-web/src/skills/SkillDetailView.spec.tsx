import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  skillsApi,
  type Skill,
  type SkillAlias,
  type SkillRelationship,
  type SkillVersion,
} from './skills-api';
import { SkillDetailView } from './SkillDetailView';
import { MANAGE, READ_ONLY, platformSession } from './test-session';

const SKILL: Skill = {
  id: 's1',
  canonical_name: 'Kubernetes',
  normalized_name: 'kubernetes',
  description: 'Container orchestration',
  status: 'active',
  merged_into_skill_id: null,
  created_at: '2026-09-18T00:00:00.000Z',
  updated_at: '2026-09-18T00:00:00.000Z',
};
const ALIAS: SkillAlias = {
  id: 'a1', skill_id: 's1', alias: 'K8s', normalized_alias: 'k8s', alias_type: 'ABBREVIATION', status: 'active',
};
const VERSION: SkillVersion = {
  id: 'v1', skill_id: 's1', version: '1.29', normalized_version: '1.29', version_family: null, status: 'active',
};
const REL: SkillRelationship = {
  id: 'r1', source_skill_id: 's1', target_skill_id: 's2', relationship_type: 'BUILT_ON',
  directionality: 'DIRECTED', status: 'active', source: 'ADMIN_CURATED', source_ref: null,
};

function mockReads() {
  vi.spyOn(skillsApi, 'getSkill').mockResolvedValue(SKILL);
  vi.spyOn(skillsApi, 'listAliases').mockResolvedValue({ aliases: [ALIAS] });
  vi.spyOn(skillsApi, 'listVersions').mockResolvedValue({ versions: [VERSION] });
  vi.spyOn(skillsApi, 'listRelationships').mockResolvedValue({ relationships: [REL] });
}

function renderDetail(scopes: string[]) {
  return render(
    <MemoryRouter initialEntries={['/skills/s1']}>
      <Routes>
        <Route path="/skills/:id" element={<SkillDetailView session={platformSession(scopes)} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SkillDetailView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the overview + tab counts from the B3 detail reads', async () => {
    mockReads();
    renderDetail(READ_ONLY);
    expect(await screen.findByRole('heading', { name: 'Kubernetes' })).toBeInTheDocument();
    expect(screen.getByText('Container orchestration')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Aliases (1)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Versions (1)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Relationships (1)' })).toBeInTheDocument();
  });

  it('shows governance controls for manage scope', async () => {
    mockReads();
    renderDetail(MANAGE);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Kubernetes' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Override…' })).toBeInTheDocument();
  });

  it('hides governance controls for read-only scope', async () => {
    mockReads();
    renderDetail(READ_ONLY);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Kubernetes' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByText(/Read-only \(platform:skill:manage required to act\)/)).toBeInTheDocument();
  });
});
