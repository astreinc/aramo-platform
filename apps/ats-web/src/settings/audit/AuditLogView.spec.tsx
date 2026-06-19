import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AuditLogView } from './AuditLogView';
import type { AuditEventView, AuditQueryResult } from './types';

// Settings Rebuild Directive 2 — the Audit log read surface (live).

function evt(over: Partial<AuditEventView> & { id: string }): AuditEventView {
  return {
    event_type: 'identity.session.issued',
    category: 'session',
    actor: { id: 'u1', type: 'user', display: 'Priya Nair' },
    subject_id: '40000000-0000-7000-8000-000000000001',
    detail: 'Signed in',
    created_at: '2026-06-05T10:00:00.000Z',
    ...over,
  };
}

describe('AuditLogView', () => {
  it('renders the live trail with readable event + actor + detail', async () => {
    const fetchFn = vi.fn(async () => ({
      items: [
        evt({ id: 'e5', detail: 'Signed in' }),
        evt({
          id: 'e2',
          event_type: 'identity.tenant_user.role_assigned',
          category: 'access',
          detail: 'Assigned role(s): recruiter',
        }),
      ],
      next_cursor: null,
    } satisfies AuditQueryResult));
    render(<AuditLogView fetchFn={fetchFn} />);
    expect(await screen.findByText('Signed in')).toBeInTheDocument();
    expect(screen.getByText('Assigned role(s): recruiter')).toBeInTheDocument();
    expect(screen.getAllByText('Priya Nair').length).toBe(2);
    // Category pills (readable label, not raw event_type).
    expect(screen.getByText('Access')).toBeInTheDocument();
  });

  it('applies filters and reloads (passes them to the fetcher)', async () => {
    const fetchFn = vi.fn(async () => ({ items: [], next_cursor: null }));
    render(<AuditLogView fetchFn={fetchFn} />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('audit-filter-event-type'), {
      target: { value: 'identity.session.issued' },
    });
    fireEvent.change(screen.getByTestId('audit-filter-from'), {
      target: { value: '2026-06-01' },
    });
    fireEvent.click(screen.getByTestId('audit-apply'));

    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    const lastArg = fetchFn.mock.calls[1]?.[0] as { filters?: Record<string, string> };
    expect(lastArg.filters?.['event_type']).toBe('identity.session.issued');
    expect(lastArg.filters?.['from']).toBe('2026-06-01T00:00:00.000Z');
  });

  it('walks the keyset cursor on Load more (appends, no duplicates)', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ items: [evt({ id: 'e5' })], next_cursor: 'CUR1' })
      .mockResolvedValueOnce({ items: [evt({ id: 'e4' })], next_cursor: null });
    render(<AuditLogView fetchFn={fetchFn} />);
    expect(await screen.findByTestId('audit-load-more')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('audit-load-more'));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    // Second call carried the cursor forward.
    expect((fetchFn.mock.calls[1]?.[0] as { cursor?: string }).cursor).toBe('CUR1');
    // No more pages → the button is gone.
    await waitFor(() =>
      expect(screen.queryByTestId('audit-load-more')).not.toBeInTheDocument(),
    );
  });

  it('surfaces an error honestly', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('boom');
    });
    render(<AuditLogView fetchFn={fetchFn} />);
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  it('shows an empty state when there are no events', async () => {
    const fetchFn = vi.fn(async () => ({ items: [], next_cursor: null }));
    render(<AuditLogView fetchFn={fetchFn} />);
    expect(
      await screen.findByText(/No audit events match these filters/i),
    ).toBeInTheDocument();
  });
});
