import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { skillsApi, type Skill } from './skills-api';
import { SkillsRegistryView } from './SkillsRegistryView';
import { MANAGE, READ_ONLY, platformSession } from './test-session';

const SKILLS: Skill[] = [
  {
    id: 's1',
    canonical_name: 'Kubernetes',
    normalized_name: 'kubernetes',
    description: null,
    status: 'active',
    merged_into_skill_id: null,
    created_at: '2026-09-18T00:00:00.000Z',
    updated_at: '2026-09-18T00:00:00.000Z',
  },
];

function renderView(scopes: string[]) {
  return render(
    <MemoryRouter>
      <SkillsRegistryView session={platformSession(scopes)} />
    </MemoryRouter>,
  );
}

describe('SkillsRegistryView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists canonical skills', async () => {
    vi.spyOn(skillsApi, 'listSkills').mockResolvedValue({ skills: SKILLS });
    renderView(READ_ONLY);
    expect(await screen.findByText('Kubernetes')).toBeInTheDocument();
    expect(screen.getByText('kubernetes')).toBeInTheDocument();
  });

  it('shows Create for manage scope', async () => {
    vi.spyOn(skillsApi, 'listSkills').mockResolvedValue({ skills: SKILLS });
    renderView(MANAGE);
    await waitFor(() => expect(screen.getByText('Kubernetes')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Create skill' })).toBeInTheDocument();
  });

  it('hides Create for read-only scope', async () => {
    vi.spyOn(skillsApi, 'listSkills').mockResolvedValue({ skills: SKILLS });
    renderView(READ_ONLY);
    await waitFor(() => expect(screen.getByText('Kubernetes')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Create skill' })).not.toBeInTheDocument();
  });
});
