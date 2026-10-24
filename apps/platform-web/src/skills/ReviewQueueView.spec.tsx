import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { skillsApi } from './skills-api';
import { ReviewQueueView, queueFooterLine } from './ReviewQueueView';
import { mockDirectory } from './skill-fixtures';
import { MANAGE, READ_ONLY, platformSession } from './test-session';

function renderQueue(scopes: string[]) {
  return render(
    <MemoryRouter>
      <ReviewQueueView session={platformSession(scopes)} />
    </MemoryRouter>,
  );
}

const PAGE1 = { rows: [{ surface_form: 'k8s admin', occurrence_count: 214, tenant_count: 9 }], next_cursor: 'c1' };
const PAGE2 = { rows: [{ surface_form: 'helm charts', occurrence_count: 7, tenant_count: 2 }], next_cursor: null };

describe('ReviewQueueView', () => {
  it('counts-only rows, no First seen column (R-9), cursor Load more', async () => {
    mockDirectory();
    const list = vi.spyOn(skillsApi, 'listReviewQueue').mockResolvedValueOnce(PAGE1).mockResolvedValueOnce(PAGE2);
    renderQueue(READ_ONLY);
    expect(await screen.findByText('“k8s admin”')).toBeInTheDocument();
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['Surface form', 'Domain', 'Occurrences', 'Tenants', 'Actions']);
    expect(screen.getByText('Showing 1 · more available · 50 per page')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('“helm charts”')).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c1', limit: 50 }));
    expect(screen.getByText('Showing 2 · 50 per page')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('the domain segment filters server-side and labels the Domain column', async () => {
    mockDirectory();
    const list = vi.spyOn(skillsApi, 'listReviewQueue').mockResolvedValue({ ...PAGE1, next_cursor: null });
    renderQueue(READ_ONLY);
    await screen.findByText('“k8s admin”');
    fireEvent.click(screen.getByRole('button', { name: 'Talent' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ sourceDomain: 'talent', minOccurrence: 1 })));
    expect(await screen.findByRole('cell', { name: 'Talent' })).toBeInTheDocument();
  });

  it(':read sees the view-only note and no row actions', async () => {
    mockDirectory();
    vi.spyOn(skillsApi, 'listReviewQueue').mockResolvedValue({ ...PAGE1, next_cursor: null });
    renderQueue(READ_ONLY);
    await screen.findByText('“k8s admin”');
    expect(screen.getByRole('note')).toHaveTextContent(
      'View only. Adding aliases and creating skills needs the Manage skills permission.',
    );
    expect(screen.queryByRole('button', { name: 'Add as alias…' })).not.toBeInTheDocument();
  });

  it('Add as alias… picks a skill by name and the real alias type', async () => {
    mockDirectory();
    vi.spyOn(skillsApi, 'listReviewQueue').mockResolvedValue({ ...PAGE1, next_cursor: null });
    const add = vi.spyOn(skillsApi, 'addAlias').mockResolvedValue({
      id: 'a', skill_id: 's-kube', alias: 'k8s admin', normalized_alias: 'k8s admin', alias_type: 'COMMON_NAME', status: 'active',
    });
    renderQueue(MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Add as alias…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Add “k8s admin” as an alias')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Kubernetes' })).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText(/^Skill/), { target: { value: 's-kube' } });
    fireEvent.change(within(dialog).getByLabelText(/Alias type/), { target: { value: 'ABBREVIATION' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add alias' }));
    await waitFor(() => expect(add).toHaveBeenCalledWith('s-kube', { alias: 'k8s admin', alias_type: 'ABBREVIATION' }));
  });

  it('empty state', async () => {
    mockDirectory();
    vi.spyOn(skillsApi, 'listReviewQueue').mockResolvedValue({ rows: [], next_cursor: null });
    renderQueue(READ_ONLY);
    expect(await screen.findByText('Nothing waiting at this threshold.')).toBeInTheDocument();
    expect(queueFooterLine(0, false)).toBe('Showing 0 · 50 per page');
  });
});
