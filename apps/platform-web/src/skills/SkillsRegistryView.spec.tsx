import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '@aramo/fe-foundation';
import { describe, expect, it, vi } from 'vitest';

import { skillsApi } from './skills-api';
import { SkillsRegistryView, filterSkills } from './SkillsRegistryView';
import { ALL_SKILLS, DOCKER, KUBE, mockDirectory, skill } from './skill-fixtures';
import { MANAGE, READ_ONLY, platformSession } from './test-session';

function renderRegistry(scopes: string[]) {
  return render(
    <MemoryRouter>
      <SkillsRegistryView session={platformSession(scopes)} />
    </MemoryRouter>,
  );
}

describe('SkillsRegistryView', () => {
  it('lists name · normalized · status · updated — no Aliases column (R-9)', async () => {
    mockDirectory([KUBE, DOCKER]);
    renderRegistry(READ_ONLY);
    expect(await screen.findByRole('link', { name: 'Kubernetes' })).toBeInTheDocument();
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['Canonical name', 'Normalized', 'Status', 'Updated']);
    expect(screen.getByText('2 skills')).toBeInTheDocument();
    expect(screen.getAllByText('12 Oct 2026')).toHaveLength(2);
  });

  it(':read sees the view-only note and no Create button', async () => {
    mockDirectory();
    renderRegistry(READ_ONLY);
    await screen.findByRole('link', { name: 'Kubernetes' });
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('View only. Changing skills needs the Manage skills permission.');
    expect(screen.queryByRole('button', { name: '+ Create skill' })).not.toBeInTheDocument();
  });

  it(':manage creates a skill and shows SKILL_CONFLICT in plain copy', async () => {
    mockDirectory();
    const create = vi
      .spyOn(skillsApi, 'createSkill')
      .mockRejectedValue(new ApiError(409, 'dup', 'SKILL_CONFLICT', { constraint: 'normalized_name' }));
    renderRegistry(MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: '+ Create skill' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Canonical name/), { target: { value: 'Kubernetes' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create skill' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'A skill with this name already exists. (SKILL_CONFLICT)',
    );
    expect(create).toHaveBeenCalledWith({ canonical_name: 'Kubernetes', description: null });
  });

  it('Include inactive re-reads with include_inactive', async () => {
    const list = mockDirectory();
    renderRegistry(READ_ONLY);
    await screen.findByRole('link', { name: 'Kubernetes' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include inactive' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ includeInactive: true }));
  });

  it('search covers names only (aliases are not in the list response)', () => {
    expect(filterSkills(ALL_SKILLS, 'kube').map((s) => s.canonical_name)).toEqual(['Kubernetes']);
    expect(filterSkills(ALL_SKILLS, 'k8s')).toEqual([]);
    expect(filterSkills([skill('x', 'React')], '  ')).toHaveLength(1);
  });
});
