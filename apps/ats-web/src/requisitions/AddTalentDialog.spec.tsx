import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError, ToastProvider } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AddTalentDialog } from './AddTalentDialog';

// ATS-QA-1 D3 — the Add-talent picker searches and pages on the SERVER
// (GET /v1/talent-records?paged=true&q=&cursor=), never a client-side slice of
// the first page. 1.1 residual — disabled with a reason on draft / awaiting approval.
const h = vi.hoisted(() => ({
  searchTalentForPicker: vi.fn(),
  addTalentToPipeline: vi.fn(),
}));
vi.mock('../talent/talent-api', () => ({ searchTalentForPicker: h.searchTalentForPicker }));
vi.mock('../pipeline/pipeline-api', () => ({ addTalentToPipeline: h.addTalentToPipeline }));

const talent = (id: string, first: string, last: string) => ({
  id, tenant_id: 't', site_id: null, first_name: first, last_name: last,
  email1: null, phone_cell: null, city: null, state: null, title: null, key_skills: null,
});
const page = (items: unknown[], next_cursor: string | null = null) => ({ items, next_cursor, facets: {} });

function renderDialog(props: Partial<Parameters<typeof AddTalentDialog>[0]> = {}) {
  const onAdded = vi.fn();
  render(
    <ToastProvider>
      <AddTalentDialog requisitionId="r1" existingTalentIds={[]} onAdded={onAdded} {...props} />
    </ToastProvider>,
  );
  return { onAdded };
}

const openDialog = () => fireEvent.click(screen.getByRole('button', { name: /Add talent/ }));

beforeEach(() => {
  h.searchTalentForPicker.mockReset();
  h.addTalentToPipeline.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('AddTalentDialog (ATS-QA-1 D3 / 1.1)', () => {
  it('sends the typed name to the server search (debounced) and finds a record not on the first page', async () => {
    h.searchTalentForPicker.mockImplementation(async (args: { q?: string }) =>
      args.q === 'Zed' ? page([talent('t99', 'Zed', 'Older')]) : page([talent('t1', 'Ada', 'Newest')], 'c1'),
    );
    renderDialog();
    openDialog();
    expect(await screen.findByText('Ada Newest')).toBeInTheDocument();
    expect(h.searchTalentForPicker).toHaveBeenCalledWith({ q: '' });
    fireEvent.change(screen.getByPlaceholderText(/Name, title, skill or location/), { target: { value: 'Zed' } });
    expect(await screen.findByText('Zed Older')).toBeInTheDocument();
    expect(h.searchTalentForPicker).toHaveBeenLastCalledWith({ q: 'Zed' });
    expect(screen.queryByText('Ada Newest')).toBeNull();
  });

  it('pages with the server cursor ("Show more") and never caps the list client-side', async () => {
    const first = Array.from({ length: 30 }, (_, i) => talent(`a${i}`, 'First', `P${i}`));
    h.searchTalentForPicker.mockImplementation(async (args: { cursor?: string | null }) =>
      args.cursor === 'c1' ? page([talent('b1', 'Second', 'Page')]) : page(first, 'c1'),
    );
    renderDialog();
    openDialog();
    expect(await screen.findByText('First P29')).toBeInTheDocument(); // all 30 rendered (no 25 slice)
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Second Page')).toBeInTheDocument();
    expect(h.searchTalentForPicker).toHaveBeenLastCalledWith({ q: '', cursor: 'c1' });
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('marks talent already live on the requisition and does not let them be added again', async () => {
    h.searchTalentForPicker.mockResolvedValue(page([talent('t1', 'Ada', 'Live'), talent('t2', 'Bob', 'Free')]));
    renderDialog({ existingTalentIds: ['t1'] });
    openDialog();
    const live = (await screen.findByText('Ada Live')).closest('button') as HTMLButtonElement;
    expect(live).toBeDisabled();
    expect(within(live).getByText('Already on this requisition')).toBeInTheDocument();
    const free = screen.getByText('Bob Free').closest('button') as HTMLButtonElement;
    expect(free).not.toBeDisabled();
  });

  it('adds the chosen talent and reports the server refusal through addTalentErrorMessage', async () => {
    h.searchTalentForPicker.mockResolvedValue(page([talent('t2', 'Bob', 'Free')]));
    h.addTalentToPipeline.mockRejectedValue(new ApiError(409, 'conflict', 'PIPELINE_TRANSITION_CONFLICT'));
    renderDialog();
    openDialog();
    fireEvent.click((await screen.findByText('Bob Free')).closest('button') as HTMLButtonElement);
    expect(await screen.findByText(/Something changed at the same moment/)).toBeInTheDocument();
    expect(screen.queryByText(/already on this requisition/i)).toBeNull();
    expect(h.addTalentToPipeline).toHaveBeenCalledWith('t2', 'r1');
  });

  it('without talent:search the name search is off and says so honestly; no ?q= is sent', async () => {
    h.searchTalentForPicker.mockResolvedValue(page([talent('t1', 'Ada', 'Pool')]));
    renderDialog({ canSearch: false });
    openDialog();
    expect(await screen.findByText('Ada Pool')).toBeInTheDocument();
    expect(screen.getByText(/You don’t have permission to search talent/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search is not available to you/)).toBeDisabled();
    expect(h.searchTalentForPicker).toHaveBeenCalledWith({ q: undefined });
  });

  it('a server 403 on the search falls back to the honest no-permission state', async () => {
    h.searchTalentForPicker.mockImplementation(async (args: { q?: string }) => {
      if (args.q === 'Ada') throw new ApiError(403, 'no', 'INSUFFICIENT_PERMISSIONS', { reason: 'search_scope_missing' });
      return page([talent('t1', 'Ada', 'Pool')]);
    });
    renderDialog();
    openDialog();
    await screen.findByText('Ada Pool');
    fireEvent.change(screen.getByPlaceholderText(/Name, title, skill or location/), { target: { value: 'Ada' } });
    expect(await screen.findByText(/You don’t have permission to search talent/)).toBeInTheDocument();
  });

  it('shows an honest empty state for a search with no match', async () => {
    h.searchTalentForPicker.mockImplementation(async (args: { q?: string }) =>
      args.q === 'nobody' ? page([]) : page([talent('t1', 'Ada', 'Pool')]),
    );
    renderDialog();
    openDialog();
    await screen.findByText('Ada Pool');
    fireEvent.change(screen.getByPlaceholderText(/Name, title, skill or location/), { target: { value: 'nobody' } });
    expect(await screen.findByText('No talent matches “nobody”.')).toBeInTheDocument();
  });

  it('1.1 — disabled with a visible reason when the requisition cannot take talent', () => {
    renderDialog({ disabledReason: 'Talent can be added once this requisition is approved.' });
    const btn = screen.getByRole('button', { name: /Add talent/ });
    expect(btn).toBeDisabled();
    expect(screen.getByText('Talent can be added once this requisition is approved.')).toBeInTheDocument();
    expect(h.searchTalentForPicker).not.toHaveBeenCalled();
  });
});

describe('AddTalentDialog loading', () => {
  it('does not search until the dialog opens', async () => {
    h.searchTalentForPicker.mockResolvedValue(page([]));
    renderDialog();
    await waitFor(() => expect(h.searchTalentForPicker).not.toHaveBeenCalled());
  });
});
