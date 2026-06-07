import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import { ToastProvider } from '../components/Toast';
import type { CompanyListState } from '../companies/companies-api';

import { TeamClientsView } from './TeamClientsView';
import type { TeamClientOwnershipRow } from './types';

const rows: TeamClientOwnershipRow[] = [
  {
    id: 'o1',
    tenant_id: 't',
    team_id: 't-1',
    company_id: 'c-acme',
    assigned_at: '2026-01-01T00:00:00.000Z',
    assigned_by_id: null,
  },
];

const readyCompanies: CompanyListState = {
  state: 'ready',
  companies: [
    { id: 'c-acme', name: 'Acme', city: 'NYC', state: 'NY' },
    { id: 'c-globex', name: 'Globex', city: null, state: null },
  ],
};

function renderView(opts?: {
  rowItems?: readonly TeamClientOwnershipRow[];
  companies?: CompanyListState;
  addFn?: typeof import('./assignments-api').addTeamClient;
  removeFn?: typeof import('./assignments-api').removeTeamClient;
}) {
  const fetchClientsFn = vi.fn(async () => ({
    items: opts?.rowItems ?? rows,
  }));
  const probeCompanyListFn = vi.fn(async () =>
    opts?.companies ?? readyCompanies,
  );
  const addFn = opts?.addFn ?? vi.fn();
  const removeFn = opts?.removeFn ?? vi.fn();
  return {
    ...render(
      <MemoryRouter>
        <ToastProvider>
          <TeamClientsView
            teamIdOverride="t-1"
            fetchClientsFn={fetchClientsFn}
            probeCompanyListFn={probeCompanyListFn}
            addFn={addFn}
            removeFn={removeFn}
          />
        </ToastProvider>
      </MemoryRouter>,
    ),
    fetchClientsFn,
    addFn,
    removeFn,
  };
}

describe('TeamClientsView (E)', () => {
  it('renders the clients list joined to the company list', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());
    expect(screen.getByTestId('client-row-c-acme')).toBeInTheDocument();
  });

  it('renders the documented company-picker limitation note (ruling 2)', async () => {
    renderView();
    await waitFor(() =>
      expect(
        screen.getByText(/Only companies visible to your role are listed/i),
      ).toBeInTheDocument(),
    );
  });

  it('Combobox COMPANY-picker is pre-filtered to non-client companies', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('add-client-combobox'));
    // Acme is already a client; Globex remains.
    expect(
      screen.getByTestId('add-client-combobox-option-c-globex'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('add-client-combobox-option-c-acme'),
    ).not.toBeInTheDocument();
  });

  it('add-client: select + Add → POST', async () => {
    const addFn = vi.fn(async () => ({
      id: 'o2',
      team_id: 't-1',
      company_id: 'c-globex',
    }));
    const { fetchClientsFn } = renderView({ addFn });
    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('add-client-combobox'));
    fireEvent.click(screen.getByTestId('add-client-combobox-option-c-globex'));
    fireEvent.click(screen.getByTestId('add-client-submit'));
    await waitFor(() =>
      expect(addFn).toHaveBeenCalledWith({
        teamId: 't-1',
        body: { company_id: 'c-globex' },
      }),
    );
    await waitFor(() => expect(fetchClientsFn).toHaveBeenCalledTimes(2));
  });

  it('IDEMPOTENT add (uniform ruling 1): duplicate POST resolves silently — no error UI', async () => {
    const addFn = vi.fn(async () => ({
      id: 'o-existing',
      team_id: 't-1',
      company_id: 'c-globex',
    }));
    renderView({ addFn });
    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('add-client-combobox'));
    fireEvent.click(screen.getByTestId('add-client-combobox-option-c-globex'));
    fireEvent.click(screen.getByTestId('add-client-submit'));
    await waitFor(() => expect(addFn).toHaveBeenCalledTimes(1));
    // The "Only companies visible to your role are listed" alert IS
    // present (it's an InlineAlert; uses role=alert). Filter to ones in
    // the add path — the absence of a DUPLICATE-add error means no add-
    // error alert was added beyond the limitation note.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('remove: inline confirm → DELETE → refresh', async () => {
    const removeFn = vi.fn(async () => undefined);
    const { fetchClientsFn } = renderView({ removeFn });
    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('remove-client-c-acme'));
    expect(screen.getByText('Remove?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-remove-client-c-acme'));
    await waitFor(() =>
      expect(removeFn).toHaveBeenCalledWith({
        teamId: 't-1',
        companyId: 'c-acme',
      }),
    );
    await waitFor(() => expect(fetchClientsFn).toHaveBeenCalledTimes(2));
  });

  it('IDEMPOTENT DELETE 404 (uniform ruling 1): treated as SUCCESS', async () => {
    const removeFn = vi.fn(async () => {
      throw new ApiError(404, 'gone', 'NOT_FOUND', {});
    });
    const { fetchClientsFn } = renderView({ removeFn });
    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('remove-client-c-acme'));
    fireEvent.click(screen.getByTestId('confirm-remove-client-c-acme'));
    await waitFor(() => expect(removeFn).toHaveBeenCalled());
    await waitFor(() => expect(fetchClientsFn).toHaveBeenCalledTimes(2));
  });

  it('ruling 5: 403 fallback renders raw-UUID input + helper', async () => {
    renderView({ companies: { state: 'forbidden' } });
    await waitFor(() =>
      expect(screen.getByTestId('client-row-c-acme')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('add-client-uuid-input')).toBeInTheDocument();
    expect(
      screen.getByText(/Company list unavailable to your role/i),
    ).toBeInTheDocument();
    // The documented-limitation note only renders when the picker is
    // available; in the 403 fallback the limitation is moot (the UUID
    // path bypasses the picker entirely).
    expect(
      screen.queryByText(/Only companies visible to your role are listed/i),
    ).not.toBeInTheDocument();
  });
});
