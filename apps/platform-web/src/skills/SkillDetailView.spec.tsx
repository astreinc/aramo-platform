import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { skillsApi, type Skill } from './skills-api';
import { SkillDetailView, relationshipView } from './SkillDetailView';
import { K8S, KUBE, REQUIRES_DOCKER, TERRA_BUILT_ON_KUBE, V129, mockDirectory } from './skill-fixtures';
import { MANAGE, READ_ONLY, platformSession } from './test-session';

function mockReads(s: Skill = KUBE) {
  mockDirectory();
  vi.spyOn(skillsApi, 'getSkill').mockResolvedValue(s);
  vi.spyOn(skillsApi, 'listAliases').mockResolvedValue({ aliases: [K8S] });
  vi.spyOn(skillsApi, 'listVersions').mockResolvedValue({ versions: [V129] });
  vi.spyOn(skillsApi, 'listRelationships').mockResolvedValue({ relationships: [REQUIRES_DOCKER, TERRA_BUILT_ON_KUBE] });
}

function renderDetail(scopes: string[]) {
  return render(
    <MemoryRouter initialEntries={['/skills/s-kube']}>
      <Routes>
        <Route path="/skills/:id" element={<SkillDetailView session={platformSession(scopes)} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SkillDetailView', () => {
  it('header shows `id · normalized` in mono and the tab counts', async () => {
    mockReads();
    renderDetail(READ_ONLY);
    expect(await screen.findByRole('heading', { name: 'Kubernetes' })).toBeInTheDocument();
    expect(screen.getByText('s-kube · kubernetes')).toHaveClass('pw-sk-dhead__ids');
    expect(screen.getByRole('tab', { name: 'Aliases (1)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Versions (1)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Relationships (2)' })).toBeInTheDocument();
  });

  it(':read sees the view-only note; actions and add rows are not offered', async () => {
    mockReads();
    renderDetail(READ_ONLY);
    await screen.findByRole('heading', { name: 'Kubernetes' });
    expect(screen.getByRole('note')).toHaveTextContent('Changing skills needs the Manage skills permission.');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Aliases (1)' }));
    expect(screen.queryByRole('textbox', { name: 'Surface form' })).not.toBeInTheDocument();
    expect(screen.getByText('Abbreviation')).toBeInTheDocument();
    expect(screen.getByText('ABBREVIATION')).toHaveClass('pw-sk-code');
  });

  it(':manage sees Edit · Override… · Merge into… · Deactivate…', async () => {
    mockReads();
    renderDetail(MANAGE);
    await screen.findByRole('heading', { name: 'Kubernetes' });
    for (const name of ['Edit', 'Override…', 'Merge into…', 'Deactivate…']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Merge into…' })).toHaveClass('pw-sk-btn-merge');
  });

  it('relationships show NAMES and the server direction, in both orientations', async () => {
    mockReads();
    renderDetail(READ_ONLY);
    await screen.findByRole('heading', { name: 'Kubernetes' });
    fireEvent.click(screen.getByRole('tab', { name: 'Relationships (2)' }));
    expect(await screen.findByRole('link', { name: 'Docker' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Terraform' })).toBeInTheDocument();
    expect(screen.getByText('→ Directed · Admin curated')).toBeInTheDocument();
    expect(screen.getByText('→ Directed · AI recommended')).toBeInTheDocument();
    expect(screen.queryByText(/s-dock/)).not.toBeInTheDocument();
    expect(relationshipView(TERRA_BUILT_ON_KUBE, 's-kube').selfFirst).toBe(false);
    expect(relationshipView(REQUIRES_DOCKER, 's-kube').selfFirst).toBe(true);
  });

  it('merge needs a winner AND the acknowledgement, then opens the winner', async () => {
    mockReads();
    const merge = vi.spyOn(skillsApi, 'mergeSkill').mockResolvedValue({ ...KUBE, status: 'inactive' });
    renderDetail(MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Merge into…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Merge Kubernetes into…')).toBeInTheDocument();
    const commit = within(dialog).getByRole('button', { name: 'Merge skills' });
    expect(commit).toBeDisabled();
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Docker' })).toBeInTheDocument());
    // inactive skills are not merge winners
    expect(within(dialog).queryByRole('option', { name: 'Payroll processing' })).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Winner/), { target: { value: 's-dock' } });
    expect(commit).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    expect(commit).toBeEnabled();
    fireEvent.click(commit);
    await waitFor(() => expect(merge).toHaveBeenCalledWith('s-kube', { winner_skill_id: 's-dock' }));
    await waitFor(() => expect(skillsApi.getSkill).toHaveBeenLastCalledWith('s-dock'));
  });

  it('override requires a reason and sends the optional surface form', async () => {
    mockReads();
    const override = vi.spyOn(skillsApi, 'overrideSkill').mockResolvedValue({ ok: true });
    renderDetail(MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Override…' }));
    const dialog = await screen.findByRole('dialog');
    const commit = within(dialog).getByRole('button', { name: 'Save override' });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Surface form/), { target: { value: 'k8s admin' } });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Ops shorthand' } });
    fireEvent.click(commit);
    await waitFor(() =>
      expect(override).toHaveBeenCalledWith('s-kube', { surface_form: 'k8s admin', reason: 'Ops shorthand' }),
    );
  });

  it('deactivate shows Active → Inactive and calls deactivate', async () => {
    mockReads();
    const deactivate = vi.spyOn(skillsApi, 'deactivateSkill').mockResolvedValue({ ...KUBE, status: 'inactive' });
    renderDetail(MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Change')).toBeInTheDocument();
    expect(within(dialog).getByText('Active')).toBeInTheDocument();
    expect(within(dialog).getByText('Inactive')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(deactivate).toHaveBeenCalledWith('s-kube'));
  });

  it('an inactive skill offers Reactivate…', async () => {
    mockReads({ ...KUBE, status: 'inactive' });
    const reactivate = vi.spyOn(skillsApi, 'reactivateSkill').mockResolvedValue(KUBE);
    renderDetail(MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reactivate' }));
    await waitFor(() => expect(reactivate).toHaveBeenCalledWith('s-kube'));
  });

  it('inline alias add sends the surface and the real alias type', async () => {
    mockReads();
    const add = vi.spyOn(skillsApi, 'addAlias').mockResolvedValue(K8S);
    renderDetail(MANAGE);
    await screen.findByRole('heading', { name: 'Kubernetes' });
    fireEvent.click(screen.getByRole('tab', { name: 'Aliases (1)' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Surface form' }), { target: { value: 'Kube' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Alias type' }), { target: { value: 'SPELLING_VARIANT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add alias' }));
    await waitFor(() => expect(add).toHaveBeenCalledWith('s-kube', { alias: 'Kube', alias_type: 'SPELLING_VARIANT' }));
  });

  it('a version toggles Active ⇄ Inactive', async () => {
    mockReads();
    const update = vi.spyOn(skillsApi, 'updateVersion').mockResolvedValue({ ...V129, status: 'inactive' });
    renderDetail(MANAGE);
    await screen.findByRole('heading', { name: 'Kubernetes' });
    fireEvent.click(screen.getByRole('tab', { name: 'Versions (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change status of version 1.29' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('s-kube', 'v-129', { status: 'inactive' }));
  });
});
