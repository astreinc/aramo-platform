import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '@aramo/fe-foundation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AddToRequisitionDialog, requisitionOptionLabel } from './AddToRequisitionDialog';

// ATS-QA-1 D4 — the shared requisition picker: server keyset paging + search (title or REQ
// number), statuses open / on hold / lead (A1 AM-1) filtered server-side, labelled
// title · REQ-number · client.
const h = vi.hoisted(() => ({
  listRequisitionsForPicker: vi.fn(),
  listCompanies: vi.fn(),
  addTalentToPipeline: vi.fn(),
  setPipelineResumeEdition: vi.fn(),
  listTalentResumeEditions: vi.fn(),
}));
vi.mock('../requisitions/requisitions-api', () => ({ listRequisitionsForPicker: h.listRequisitionsForPicker }));
vi.mock('../companies/companies-api', () => ({ listCompanies: h.listCompanies }));
vi.mock('../pipeline/pipeline-api', () => ({
  addTalentToPipeline: h.addTalentToPipeline,
  setPipelineResumeEdition: h.setPipelineResumeEdition,
}));
vi.mock('./talent-api', () => ({ listTalentResumeEditions: h.listTalentResumeEditions }));

const req = (id: string, title: string, n: number, status: string, company_id = 'c1') => ({
  id, title, requisition_number: n, status, company_id,
});

beforeEach(() => {
  h.listRequisitionsForPicker.mockReset();
  h.listCompanies.mockReset();
  h.addTalentToPipeline.mockReset();
  h.setPipelineResumeEdition.mockReset();
  h.listTalentResumeEditions.mockReset();
  h.listCompanies.mockResolvedValue({ items: [{ id: 'c1', name: 'Acme Health' }] });
});

function renderDialog(canSearch = true) {
  render(<AddToRequisitionDialog open onClose={() => undefined} talentId="t1" canSearch={canSearch} canSetResume={false} />);
}

describe('requisitionOptionLabel', () => {
  it('joins title · REQ-number · client and omits an unresolved client', () => {
    expect(requisitionOptionLabel({ title: 'BA', requisition_number: 42 }, 'Acme')).toBe('BA · REQ-42 · Acme');
    expect(requisitionOptionLabel({ title: 'BA', requisition_number: 42 }, undefined)).toBe('BA · REQ-42');
  });
});

describe('AddToRequisitionDialog — shared RequisitionPicker (ATS-QA-1 D4)', () => {
  it('asks the server for open, on hold and lead requisitions; labels with REQ number and client', async () => {
    h.listRequisitionsForPicker.mockResolvedValue({
      items: [req('r1', 'Open role', 1, 'open'), req('r2', 'Held role', 2, 'on_hold'), req('r3', 'Lead role', 3, 'lead')],
      next_cursor: null,
    });
    renderDialog();
    const select = await screen.findByRole('combobox', { name: 'Requisition' });
    expect(await within(select).findByRole('option', { name: 'Open role · REQ-1 · Acme Health' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Held role · REQ-2 · Acme Health' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Lead role · REQ-3 · Acme Health' })).toBeInTheDocument();
    expect(h.listRequisitionsForPicker).toHaveBeenCalledWith({ statuses: ['open', 'on_hold', 'lead'] });
  });

  it('pages through every visible requisition with Show more (no fixed cap)', async () => {
    h.listRequisitionsForPicker.mockImplementation(async (p: { cursor?: string }) =>
      p.cursor === 'c1'
        ? { items: [req('r60', 'Oldest role', 60, 'open')], next_cursor: null }
        : { items: [req('r1', 'Newest role', 100, 'open')], next_cursor: 'c1' },
    );
    renderDialog();
    await screen.findByRole('option', { name: /Newest role/ });
    fireEvent.click(screen.getByTestId('requisition-picker-more'));
    expect(await screen.findByRole('option', { name: /Oldest role/ })).toBeInTheDocument();
    expect(screen.queryByTestId('requisition-picker-more')).toBeNull();
  });

  it('sends the typed title to the server (?q=) and finds an older requisition', async () => {
    h.listRequisitionsForPicker.mockImplementation(async (p: { q?: string }) =>
      p.q === 'Legacy'
        ? { items: [req('r9', 'Legacy platform role', 9, 'open')], next_cursor: null }
        : { items: [req('r1', 'Newest role', 100, 'open')], next_cursor: null },
    );
    renderDialog();
    await screen.findByRole('option', { name: /Newest role/ });
    expect(h.listRequisitionsForPicker).toHaveBeenCalledWith({ statuses: ['open', 'on_hold', 'lead'] });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search requisitions' }), { target: { value: 'Legacy' } });
    expect(await screen.findByRole('option', { name: 'Legacy platform role · REQ-9 · Acme Health' })).toBeInTheDocument();
    expect(h.listRequisitionsForPicker).toHaveBeenLastCalledWith({ statuses: ['open', 'on_hold', 'lead'], q: 'Legacy' });
  });

  it('honest empty state for a search without results', async () => {
    h.listRequisitionsForPicker.mockImplementation(async (p: { q?: string }) =>
      p.q === 'zzz' ? { items: [], next_cursor: null } : { items: [req('r1', 'Newest role', 100, 'open')], next_cursor: null },
    );
    renderDialog();
    await screen.findByRole('option', { name: /Newest role/ });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search requisitions' }), { target: { value: 'zzz' } });
    expect(await screen.findByText('No open, on-hold or lead requisitions match “zzz”.')).toBeInTheDocument();
  });

  it('without requisition:search the box is disabled with an honest note and no ?q= is sent', async () => {
    h.listRequisitionsForPicker.mockResolvedValue({ items: [req('r1', 'Open role', 1, 'open')], next_cursor: null });
    renderDialog(false);
    await screen.findByRole('option', { name: /Open role/ });
    expect(screen.getByRole('textbox', { name: 'Search requisitions' })).toBeDisabled();
    expect(screen.getByText(/You don’t have permission to search requisitions/)).toBeInTheDocument();
    expect(h.listRequisitionsForPicker).toHaveBeenCalledWith({ statuses: ['open', 'on_hold', 'lead'] });
  });

  it('a client name that cannot be resolved is omitted, never guessed', async () => {
    h.listCompanies.mockRejectedValue(new ApiError(403, 'no', 'INSUFFICIENT_PERMISSIONS'));
    h.listRequisitionsForPicker.mockResolvedValue({ items: [req('r1', 'Open role', 1, 'open')], next_cursor: null });
    renderDialog();
    expect(await screen.findByRole('option', { name: 'Open role · REQ-1' })).toBeInTheDocument();
  });

  it('a refusal is the typed message; a 409 conflict is not reported as already on the requisition', async () => {
    h.listRequisitionsForPicker.mockResolvedValue({ items: [req('r1', 'Open role', 1, 'open')], next_cursor: null });
    h.addTalentToPipeline.mockRejectedValue(new ApiError(409, 'conflict', 'PIPELINE_TRANSITION_CONFLICT'));
    renderDialog();
    await screen.findByRole('option', { name: /Open role/ });
    fireEvent.change(screen.getByRole('combobox', { name: 'Requisition' }), { target: { value: 'r1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to requisition' }));
    expect(await screen.findByText(/Something changed at the same moment/)).toBeInTheDocument();
    expect(screen.queryByText(/already on this requisition/i)).toBeNull();
  });

  it('PIPELINE_EPISODE_ALREADY_LIVE is the only "already on this requisition" outcome', async () => {
    h.listRequisitionsForPicker.mockResolvedValue({ items: [req('r1', 'Open role', 1, 'open')], next_cursor: null });
    h.addTalentToPipeline.mockRejectedValue(new ApiError(409, 'live', 'PIPELINE_EPISODE_ALREADY_LIVE'));
    renderDialog();
    await screen.findByRole('option', { name: /Open role/ });
    fireEvent.change(screen.getByRole('combobox', { name: 'Requisition' }), { target: { value: 'r1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to requisition' }));
    expect(await screen.findByText(/already on this requisition. Nothing was changed/)).toBeInTheDocument();
  });
});

// ATS-QA-1 I-5 (amendment A4) — the résumé choice on add-to-requisition.
const edition = (id: string, over: Record<string, unknown> = {}) => ({
  edition_id: id, talent_document_id: `d-${id}`, attachment_id: null, purpose: 'GENERAL', label: null,
  lifecycle_status: 'active', created_at: '2026-10-01T00:00:00.000Z', filename: `${id}.pdf`,
  mime_type: 'application/pdf', uploaded_at: '2026-10-01T00:00:00.000Z', is_default: false,
  revision_number: null, requisition_id: null, client_context_id: null, derived_from_edition_id: null,
  processing_status: null, ...over,
});

describe('AddToRequisitionDialog — résumé choice (ATS-QA-1 I-5)', () => {
  function renderWithResume(canSetResume: boolean) {
    render(
      <MemoryRouter>
        <AddToRequisitionDialog open onClose={() => undefined} talentId="t1" canSetResume={canSetResume} />
      </MemoryRouter>,
    );
  }
  async function chooseReq() {
    await screen.findByRole('option', { name: /Open role/ });
    fireEvent.change(screen.getByRole('combobox', { name: 'Requisition' }), { target: { value: 'r1' } });
  }
  beforeEach(() => {
    h.listRequisitionsForPicker.mockResolvedValue({ items: [req('r1', 'Open role', 1, 'open')], next_cursor: null });
    h.addTalentToPipeline.mockResolvedValue({ id: 'pl-1' });
  });

  it('more than one active resume: default preselected and marked; the chosen one is written after the add', async () => {
    h.listTalentResumeEditions.mockResolvedValue({
      talent_id: 't1',
      editions: [
        edition('ed-new'),
        edition('ed-default', { is_default: true }),
        edition('ed-archived', { lifecycle_status: 'archived' }),
      ],
    });
    h.setPipelineResumeEdition.mockResolvedValue({});
    renderWithResume(true);
    await chooseReq();
    const group = await screen.findByTestId('add-resume-choice');
    expect(within(group).getByText('Current default')).toBeInTheDocument();
    expect(within(group).queryByText(/ed-archived/)).toBeNull(); // only active editions offered
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(within(group).getByRole('radio', { checked: true })).toHaveAttribute('value', 'ed-default');
    fireEvent.click(within(group).getByLabelText(/ed-new\.pdf/));
    fireEvent.click(screen.getByRole('button', { name: 'Add to requisition' }));
    expect(await screen.findByText('Talent added to the requisition.')).toBeInTheDocument();
    expect(h.addTalentToPipeline).toHaveBeenCalledWith('t1', 'r1');
    expect(h.setPipelineResumeEdition).toHaveBeenCalledWith('pl-1', { resume_edition_id: 'ed-new' });
  });

  it('keeping the preselected default writes the default (explicit confirmation)', async () => {
    h.listTalentResumeEditions.mockResolvedValue({
      talent_id: 't1',
      editions: [edition('ed-a'), edition('ed-default', { is_default: true })],
    });
    h.setPipelineResumeEdition.mockResolvedValue({});
    renderWithResume(true);
    await chooseReq();
    await screen.findByTestId('add-resume-choice');
    fireEvent.click(screen.getByRole('button', { name: 'Add to requisition' }));
    await screen.findByText('Talent added to the requisition.');
    expect(h.setPipelineResumeEdition).toHaveBeenCalledWith('pl-1', { resume_edition_id: 'ed-default' });
  });

  it('a single active resume: no prompt and no selection written (existing behaviour)', async () => {
    h.listTalentResumeEditions.mockResolvedValue({
      talent_id: 't1',
      editions: [edition('ed-only', { is_default: true }), edition('ed-old', { lifecycle_status: 'retracted' })],
    });
    renderWithResume(true);
    await chooseReq();
    await waitFor(() => expect(h.listTalentResumeEditions).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to requisition' })).not.toBeDisabled());
    expect(screen.queryByTestId('add-resume-choice')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add to requisition' }));
    await screen.findByText('Talent added to the requisition.');
    expect(h.setPipelineResumeEdition).not.toHaveBeenCalled();
  });

  it('without pipeline:resume:set: no picker, editions never read, nothing written', async () => {
    renderWithResume(false);
    await chooseReq();
    fireEvent.click(screen.getByRole('button', { name: 'Add to requisition' }));
    await screen.findByText('Talent added to the requisition.');
    expect(h.listTalentResumeEditions).not.toHaveBeenCalled();
    expect(h.setPipelineResumeEdition).not.toHaveBeenCalled();
    expect(screen.queryByTestId('add-resume-choice')).toBeNull();
  });

  it('a refused selection keeps the add, states the reason and links to the talent’s requisition page', async () => {
    h.listTalentResumeEditions.mockResolvedValue({
      talent_id: 't1',
      editions: [edition('ed-a'), edition('ed-default', { is_default: true })],
    });
    h.setPipelineResumeEdition.mockRejectedValue(new ApiError(422, 'not active', 'VALIDATION_ERROR'));
    renderWithResume(true);
    await chooseReq();
    await screen.findByTestId('add-resume-choice');
    fireEvent.click(screen.getByRole('button', { name: 'Add to requisition' }));
    expect(await screen.findByText('Talent added to the requisition.')).toBeInTheDocument();
    const refused = screen.getByTestId('add-resume-refused');
    expect(refused).toHaveTextContent('That resume has been archived or withdrawn.');
    expect(within(refused).getByRole('link', { name: 'Choose the resume for this requisition' })).toHaveAttribute(
      'href',
      '/requisitions/r1/talent/t1',
    );
  });

  it('a refused add writes no selection', async () => {
    h.listTalentResumeEditions.mockResolvedValue({
      talent_id: 't1',
      editions: [edition('ed-a'), edition('ed-default', { is_default: true })],
    });
    h.addTalentToPipeline.mockRejectedValue(new ApiError(409, 'conflict', 'PIPELINE_TRANSITION_CONFLICT'));
    renderWithResume(true);
    await chooseReq();
    await screen.findByTestId('add-resume-choice');
    fireEvent.click(screen.getByRole('button', { name: 'Add to requisition' }));
    expect(await screen.findByText(/Something changed at the same moment/)).toBeInTheDocument();
    expect(h.setPipelineResumeEdition).not.toHaveBeenCalled();
  });
});
