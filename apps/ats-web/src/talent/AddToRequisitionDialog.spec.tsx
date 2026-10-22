import { fireEvent, render, screen, within } from '@testing-library/react';
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
}));
vi.mock('../requisitions/requisitions-api', () => ({ listRequisitionsForPicker: h.listRequisitionsForPicker }));
vi.mock('../companies/companies-api', () => ({ listCompanies: h.listCompanies }));
vi.mock('../pipeline/pipeline-api', () => ({ addTalentToPipeline: h.addTalentToPipeline }));

const req = (id: string, title: string, n: number, status: string, company_id = 'c1') => ({
  id, title, requisition_number: n, status, company_id,
});

beforeEach(() => {
  h.listRequisitionsForPicker.mockReset();
  h.listCompanies.mockReset();
  h.addTalentToPipeline.mockReset();
  h.listCompanies.mockResolvedValue({ items: [{ id: 'c1', name: 'Acme Health' }] });
});

function renderDialog(canSearch = true) {
  render(<AddToRequisitionDialog open onClose={() => undefined} talentId="t1" canSearch={canSearch} />);
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
