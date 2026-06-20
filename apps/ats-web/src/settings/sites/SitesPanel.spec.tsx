import { ApiError, ToastProvider } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SitesPanel } from './SitesPanel';
import type { SiteListView, SiteView } from './types';

function site(over: Partial<SiteView> & { id: string; name: string }): SiteView {
  return {
    is_active: true,
    parent_site_id: null,
    created_at: '2026-06-20T00:00:00.000Z',
    updated_at: '2026-06-20T00:00:00.000Z',
    ...over,
  };
}

function renderPanel(opts: Parameters<typeof SitesPanel>[0]) {
  return render(
    <ToastProvider>
      <SitesPanel {...opts} />
    </ToastProvider>,
  );
}

const LIST: SiteListView = {
  items: [
    site({ id: 'hq', name: 'London HQ' }),
    site({ id: 'canary', name: 'Canary Wharf', parent_site_id: 'hq' }),
    site({ id: 'old', name: 'Closed Office', is_active: false }),
  ],
};

describe('SitesPanel', () => {
  it('lists branches with the hierarchy and a status pill', async () => {
    renderPanel({ fetchFn: () => Promise.resolve(LIST) });
    await waitFor(() => expect(screen.getByTestId('site-row-hq')).toBeInTheDocument());
    expect(screen.getByTestId('site-row-canary')).toBeInTheDocument();
    expect(screen.getByText('Closed Office')).toBeInTheDocument();
    // The inactive branch offers Reactivate, the active ones Deactivate.
    expect(screen.getByTestId('site-reactivate-old')).toBeInTheDocument();
    expect(screen.getByTestId('site-deactivate-hq')).toBeInTheDocument();
  });

  it('shows an empty state when there are no branches', async () => {
    renderPanel({ fetchFn: () => Promise.resolve({ items: [] }) });
    await waitFor(() => expect(screen.getByTestId('sites-empty')).toBeInTheDocument());
  });

  it('deactivates a branch through the confirm dialog', async () => {
    const deactivateFn = vi.fn(async (id: string) =>
      site({ id, name: 'London HQ', is_active: false }),
    );
    renderPanel({ fetchFn: () => Promise.resolve(LIST), deactivateFn });
    await waitFor(() => expect(screen.getByTestId('site-deactivate-hq')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('site-deactivate-hq'));
    fireEvent.click(screen.getByTestId('site-deactivate-confirm'));
    await waitFor(() => expect(deactivateFn).toHaveBeenCalledWith('hq'));
  });

  it('surfaces the in-use guard message when a delete is refused', async () => {
    const deleteFn = vi.fn(async () => {
      throw new ApiError(400, 'in use', 'VALIDATION_ERROR', {
        reason: 'site_in_use',
      });
    });
    renderPanel({ fetchFn: () => Promise.resolve(LIST), deleteFn });
    await waitFor(() => expect(screen.getByTestId('site-delete-hq')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('site-delete-hq'));
    fireEvent.click(screen.getByTestId('site-delete-confirm'));
    await waitFor(() =>
      expect(screen.getByText(/in use .* deactivate it instead/i)).toBeInTheDocument(),
    );
    expect(deleteFn).toHaveBeenCalledWith('hq');
  });
});
