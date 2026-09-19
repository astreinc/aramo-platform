import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { skillsApi, type ReviewQueuePage } from './skills-api';
import { ReviewQueueView } from './ReviewQueueView';
import { MANAGE, READ_ONLY, platformSession } from './test-session';

const PAGE: ReviewQueuePage = {
  rows: [{ surface_form: 'kubernetes', occurrence_count: 5, tenant_count: 3 }],
  next_cursor: null,
};

function renderView(scopes: string[]) {
  return render(
    <MemoryRouter>
      <ReviewQueueView session={platformSession(scopes)} />
    </MemoryRouter>,
  );
}

describe('ReviewQueueView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders counts-only rows (surface, occurrences, tenant_count) with no identity fields', async () => {
    vi.spyOn(skillsApi, 'listReviewQueue').mockResolvedValue(PAGE);
    renderView(READ_ONLY);
    expect(await screen.findByText('kubernetes')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // Counts-only: the data table carries no tenant/talent/requisition identifier —
    // no `tenant_id` field and no UUID in any cell. (Scoped to the table, so the
    // toolbar's domain-filter labels don't count as a leak.)
    const table = screen.getByRole('table');
    expect(table.textContent).not.toMatch(/tenant_id/i);
    expect(table.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
  });

  it('shows create/alias actions only for manage scope', async () => {
    vi.spyOn(skillsApi, 'listReviewQueue').mockResolvedValue(PAGE);
    renderView(MANAGE);
    await waitFor(() => expect(screen.getByText('kubernetes')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Create skill' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add as alias…' })).toBeInTheDocument();
  });

  it('hides mutation actions for read-only scope', async () => {
    vi.spyOn(skillsApi, 'listReviewQueue').mockResolvedValue(PAGE);
    renderView(READ_ONLY);
    await waitFor(() => expect(screen.getByText('kubernetes')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Create skill' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add as alias…' })).not.toBeInTheDocument();
  });
});
