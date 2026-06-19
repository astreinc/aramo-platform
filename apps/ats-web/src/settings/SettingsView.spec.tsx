import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';
import { ToastProvider } from '@aramo/fe-foundation';

import { SettingsView } from './SettingsView';
import type { TenantSettingsView } from './types';

const baseView: TenantSettingsView = {
  'compensation.display_default': 'both',
  'audit.financials_enabled': false,
};

afterEach(() => {
  vi.restoreAllMocks();
});

function renderView(
  view: TenantSettingsView = baseView,
  fetchFn?: () => Promise<TenantSettingsView>,
) {
  const resolved = fetchFn ?? (() => Promise.resolve(view));
  return render(
    <ToastProvider>
      <SettingsView fetchFn={resolved} />
    </ToastProvider>,
  );
}

describe('SettingsView', () => {
  it('renders the page header and the two controls after GET resolves', async () => {
    renderView();

    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('Tenant-wide configuration')).toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.getByText('Compensation display'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('Financial-auditor grant')).toBeInTheDocument();
  });

  it('uses display-only framing for the pricing picker (does not imply access-granting)', async () => {
    renderView();
    await waitFor(() =>
      expect(
        screen.getByText(/display-only/i),
      ).toBeInTheDocument(),
    );
    // Negative: no copy that implies grant/visibility change.
    expect(
      screen.queryByText(/grants? (access|visibility)/i),
    ).not.toBeInTheDocument();
  });

  it('surfaces the backend per-reason taxonomy on a bad-value PUT (ApiClient end-to-end)', async () => {
    renderView(baseView);
    await waitFor(() =>
      expect(
        screen.getByText('Compensation display'),
      ).toBeInTheDocument(),
    );

    // Pick a different value so the Save button becomes enabled.
    fireEvent.click(screen.getByLabelText('Bill markup'));

    // Stub fetch to return the S2 VALIDATION_ERROR envelope.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'bad value',
            details: {
              reason: 'invalid_value',
              key: 'compensation.display_default',
            },
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/allowed: spread, markup, both/i),
      ).toBeInTheDocument(),
    );
  });

  it('saves a valid pricing picker change via PUT and reflects the saved state', async () => {
    const saveCalls: Array<unknown[]> = [];
    const saveFn = vi.fn(async (key: string, value: unknown) => {
      saveCalls.push([key, value]);
      return { key, value, previous_value: 'both' } as unknown as never;
    });

    render(
      <ToastProvider>
        <SettingsView
          fetchFn={() => Promise.resolve(baseView)}
        />
      </ToastProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText('Compensation display')).toBeInTheDocument(),
    );

    // The real save goes through settings-api -> ApiClient.put. We stub
    // fetch at that boundary so the round-trip is end-to-end.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          key: 'compensation.display_default',
          value: 'markup',
          previous_value: 'both',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    fireEvent.click(screen.getByLabelText('Bill markup'));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(
        screen.getByTestId('comp-saved-marker'),
      ).toBeInTheDocument(),
    );
    // Save button returns to disabled when clean.
    expect(
      (screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // (Unused) saveFn left for the test-seam pattern; the round-trip
    // used the fetch stub instead.
    void saveFn;
    void saveCalls;
  });

  it('treats an ApiError without details as a generic error (fallback message stays)', async () => {
    // No details / no reason — verifies the messageForError fallback
    // returns err.message directly (the substrate-fix that landed in S5a
    // surfaces a clearer message than the old generic "Request failed").
    renderView(baseView);
    await waitFor(() =>
      expect(screen.getByText('Compensation display')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText('Bill markup'));

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: 'INTERNAL', message: 'oops' },
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(screen.getByText('oops')).toBeInTheDocument(),
    );
  });

  it('toggling the financials switch issues a PUT and surfaces details.reason on failure', async () => {
    renderView({ ...baseView, 'audit.financials_enabled': false });
    await waitFor(() =>
      expect(screen.getByText('Financial-auditor grant')).toBeInTheDocument(),
    );

    const toggle = screen.getByLabelText('Enable financial-auditor grant');

    // Success path.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          key: 'audit.financials_enabled',
          value: true,
          previous_value: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(toggle).toHaveAttribute('data-state', 'checked'),
    );

    // Failure path: rolls the optimistic flip back and surfaces the
    // ApiError message.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'cannot disable while grants exist',
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        screen.getByText(/cannot disable while grants exist/i),
      ).toBeInTheDocument(),
    );
    expect(toggle).toHaveAttribute('data-state', 'checked'); // rolled back
  });

  it('renders an error inline when the initial fetch rejects', async () => {
    const fetchFn = vi.fn(() =>
      Promise.reject(new ApiError(500, 'boom', 'INTERNAL', undefined)),
    );
    renderView(baseView, fetchFn);

    await waitFor(() =>
      expect(screen.getByText(/boom/i)).toBeInTheDocument(),
    );
  });
});
