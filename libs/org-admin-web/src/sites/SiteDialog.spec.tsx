import { ApiError, ToastProvider } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SiteDialog } from './SiteDialog';
import type { SiteView } from './types';

function site(over: Partial<SiteView> & { id: string; name: string }): SiteView {
  return {
    is_active: true,
    parent_site_id: null,
    created_at: '2026-06-20T00:00:00.000Z',
    updated_at: '2026-06-20T00:00:00.000Z',
    ...over,
  };
}

const SITES: SiteView[] = [
  site({ id: 'hq', name: 'London HQ' }),
  site({ id: 'canary', name: 'Canary Wharf', parent_site_id: 'hq' }),
  site({ id: 'old', name: 'Closed Office', is_active: false }),
];

function renderDialog(props: Partial<Parameters<typeof SiteDialog>[0]> = {}) {
  return render(
    <ToastProvider>
      <SiteDialog
        mode="create"
        open
        onOpenChange={() => undefined}
        sites={SITES}
        onSaved={() => undefined}
        {...props}
      />
    </ToastProvider>,
  );
}

describe('SiteDialog', () => {
  it('creates a branch with the chosen parent', async () => {
    const createFn = vi.fn(async () => site({ id: 'new', name: 'Soho', parent_site_id: 'hq' }));
    const onSaved = vi.fn();
    renderDialog({ createFn, onSaved });

    fireEvent.change(screen.getByTestId('site-name-input'), {
      target: { value: 'Soho' },
    });
    fireEvent.change(screen.getByTestId('site-parent-select'), {
      target: { value: 'hq' },
    });
    fireEvent.click(screen.getByTestId('site-dialog-submit'));

    await waitFor(() =>
      expect(createFn).toHaveBeenCalledWith({ name: 'Soho', parent_site_id: 'hq' }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it('only offers ACTIVE branches as parents (excludes the inactive one)', () => {
    renderDialog();
    const select = screen.getByTestId('site-parent-select');
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('London HQ');
    expect(options).not.toContain('Closed Office');
  });

  it('excludes self and descendants from the parent picker (edit mode)', () => {
    renderDialog({ mode: 'edit', site: SITES[0] });
    const select = screen.getByTestId('site-parent-select');
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    // hq itself and its child canary must not be selectable as hq's parent.
    expect(options).not.toContain('London HQ');
    expect(options).not.toContain('Canary Wharf');
  });

  it('surfaces a name-taken error from the server', async () => {
    const createFn = vi.fn(async () => {
      throw new ApiError(400, 'dup', 'VALIDATION_ERROR', { reason: 'name_taken' });
    });
    renderDialog({ createFn });
    fireEvent.change(screen.getByTestId('site-name-input'), {
      target: { value: 'London HQ' },
    });
    fireEvent.click(screen.getByTestId('site-dialog-submit'));
    await waitFor(() =>
      expect(screen.getByText(/already exists/i)).toBeInTheDocument(),
    );
  });
});
