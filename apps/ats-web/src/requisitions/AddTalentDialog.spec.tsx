import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError, ToastProvider } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { AddTalentDialog } from './AddTalentDialog';

// ATS-QA-1 D3 — the Add-talent picker searches and pages on the SERVER
// (GET /v1/talent-records?paged=true&q=&cursor=), never a client-side slice of
// the first page. 1.1 residual — disabled with a reason on draft / awaiting approval.
const h = vi.hoisted(() => ({
  searchTalentForPicker: vi.fn(),
  addTalentToPipeline: vi.fn(),
  setPipelineResumeEdition: vi.fn(),
  listTalentResumeEditions: vi.fn(),
}));
vi.mock('../talent/talent-api', () => ({
  searchTalentForPicker: h.searchTalentForPicker,
  listTalentResumeEditions: h.listTalentResumeEditions,
}));
vi.mock('../pipeline/pipeline-api', () => ({
  addTalentToPipeline: h.addTalentToPipeline,
  setPipelineResumeEdition: h.setPipelineResumeEdition,
}));

const talent = (id: string, first: string, last: string) => ({
  id, tenant_id: 't', site_id: null, first_name: first, last_name: last,
  email1: null, phone_cell: null, city: null, state: null, title: null, key_skills: null,
});
const page = (items: unknown[], next_cursor: string | null = null) => ({ items, next_cursor, facets: {} });

function renderDialog(props: Partial<Parameters<typeof AddTalentDialog>[0]> = {}) {
  const onAdded = vi.fn();
  render(
    <MemoryRouter>
      <ToastProvider>
        <AddTalentDialog requisitionId="r1" existingTalentIds={[]} onAdded={onAdded} canSetResume={false} {...props} />
      </ToastProvider>
    </MemoryRouter>,
  );
  return { onAdded };
}

const openDialog = () => fireEvent.click(screen.getByRole('button', { name: /Add talent/ }));

beforeEach(() => {
  h.searchTalentForPicker.mockReset();
  h.addTalentToPipeline.mockReset();
  h.setPipelineResumeEdition.mockReset();
  h.listTalentResumeEditions.mockReset();
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

// ATS-QA-1 I-5 (amendment A4) — the résumé choice when adding from the requisition side.
const edition = (id: string, over: Record<string, unknown> = {}) => ({
  edition_id: id, talent_document_id: `d-${id}`, attachment_id: null, purpose: 'GENERAL', label: null,
  lifecycle_status: 'active', created_at: '2026-10-01T00:00:00.000Z', filename: `${id}.pdf`,
  mime_type: 'application/pdf', uploaded_at: '2026-10-01T00:00:00.000Z', is_default: false,
  revision_number: null, requisition_id: null, client_context_id: null, derived_from_edition_id: null,
  processing_status: null, ...over,
});

describe('AddTalentDialog — résumé choice (ATS-QA-1 I-5)', () => {
  beforeEach(() => {
    h.searchTalentForPicker.mockResolvedValue(page([talent('t2', 'Bob', 'Free')]));
    h.addTalentToPipeline.mockResolvedValue({ id: 'pl-9' });
  });
  const pickBob = async () =>
    fireEvent.click((await screen.findByText('Bob Free')).closest('button') as HTMLButtonElement);

  it('several active resumes: a choice step (default preselected; tailored-for-this-requisition marked), then add + write', async () => {
    h.listTalentResumeEditions.mockResolvedValue({
      talent_id: 't2',
      editions: [
        edition('ed-default', { is_default: true }),
        edition('ed-tailored', { requisition_id: 'r1', label: 'Health focus' }),
      ],
    });
    h.setPipelineResumeEdition.mockResolvedValue({});
    const { onAdded } = renderDialog({ canSetResume: true });
    openDialog();
    await pickBob();
    const group = await screen.findByTestId('add-resume-choice');
    expect(h.addTalentToPipeline).not.toHaveBeenCalled(); // nothing added before the choice
    expect(within(group).getByText('Tailored for this requisition')).toBeInTheDocument();
    expect(within(group).getByRole('radio', { checked: true })).toHaveAttribute('value', 'ed-default');
    fireEvent.click(within(group).getByLabelText(/Health focus/));
    fireEvent.click(screen.getByRole('button', { name: 'Add to requisition' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(h.addTalentToPipeline).toHaveBeenCalledWith('t2', 'r1');
    expect(h.setPipelineResumeEdition).toHaveBeenCalledWith('pl-9', { resume_edition_id: 'ed-tailored' });
  });

  it('Back returns to the list without adding', async () => {
    h.listTalentResumeEditions.mockResolvedValue({
      talent_id: 't2',
      editions: [edition('a', { is_default: true }), edition('b')],
    });
    renderDialog({ canSetResume: true });
    openDialog();
    await pickBob();
    await screen.findByTestId('add-resume-choice');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Bob Free')).toBeInTheDocument();
    expect(h.addTalentToPipeline).not.toHaveBeenCalled();
  });

  it('one active resume: added at once, no prompt, no selection written', async () => {
    h.listTalentResumeEditions.mockResolvedValue({
      talent_id: 't2',
      editions: [edition('only', { is_default: true }), edition('gone', { lifecycle_status: 'archived' })],
    });
    const { onAdded } = renderDialog({ canSetResume: true });
    openDialog();
    await pickBob();
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(screen.queryByTestId('add-resume-choice')).toBeNull();
    expect(h.setPipelineResumeEdition).not.toHaveBeenCalled();
  });

  it('without pipeline:resume:set: added at once, editions never read', async () => {
    const { onAdded } = renderDialog({ canSetResume: false });
    openDialog();
    await pickBob();
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(h.listTalentResumeEditions).not.toHaveBeenCalled();
    expect(h.setPipelineResumeEdition).not.toHaveBeenCalled();
  });

  it('a refused selection keeps the add, shows the reason and links to the talent’s requisition page', async () => {
    h.listTalentResumeEditions.mockResolvedValue({
      talent_id: 't2',
      editions: [edition('a', { is_default: true }), edition('b')],
    });
    h.setPipelineResumeEdition.mockRejectedValue(new ApiError(403, 'no', 'INSUFFICIENT_PERMISSIONS'));
    const { onAdded } = renderDialog({ canSetResume: true });
    openDialog();
    await pickBob();
    await screen.findByTestId('add-resume-choice');
    fireEvent.click(screen.getByRole('button', { name: 'Add to requisition' }));
    const refused = await screen.findByTestId('add-resume-refused');
    expect(onAdded).toHaveBeenCalled(); // the add stands
    expect(refused).toHaveTextContent(/permission to choose the resume/);
    expect(within(refused).getByRole('link')).toHaveAttribute('href', '/requisitions/r1/talent/t2');
  });

  it('a refused add (concurrent add of the same talent) writes no selection', async () => {
    h.listTalentResumeEditions.mockResolvedValue({
      talent_id: 't2',
      editions: [edition('a', { is_default: true }), edition('b')],
    });
    h.addTalentToPipeline.mockRejectedValue(new ApiError(409, 'live', 'PIPELINE_EPISODE_ALREADY_LIVE'));
    renderDialog({ canSetResume: true });
    openDialog();
    await pickBob();
    await screen.findByTestId('add-resume-choice');
    fireEvent.click(screen.getByRole('button', { name: 'Add to requisition' }));
    await waitFor(() => expect(h.addTalentToPipeline).toHaveBeenCalled());
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(h.setPipelineResumeEdition).not.toHaveBeenCalled();
  });
});
