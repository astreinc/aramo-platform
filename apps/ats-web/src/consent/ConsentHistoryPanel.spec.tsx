import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ConsentHistoryPanel } from './ConsentHistoryPanel';
import type { ConsentHistoryResponse } from './types';

const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

const firstPage: ConsentHistoryResponse = {
  events: [
    {
      event_id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a00',
      scope: 'profile_storage',
      action: 'granted',
      created_at: '2026-04-29T00:00:00Z',
      expires_at: null,
    },
  ],
  next_cursor: 'opaque-cursor-1',
  is_anonymized: false,
};

const secondPage: ConsentHistoryResponse = {
  events: [
    {
      event_id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a01',
      scope: 'profile_storage',
      action: 'revoked',
      created_at: '2026-04-30T00:00:00Z',
      expires_at: null,
    },
  ],
  next_cursor: null,
  is_anonymized: false,
};

const finalPage: ConsentHistoryResponse = {
  ...firstPage,
  next_cursor: null,
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ConsentHistoryPanel', () => {
  it('renders the first page of history events', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(firstPage));
    render(<ConsentHistoryPanel talentId={TALENT_ID} />);

    await waitFor(() => {
      expect(
        screen.getByTestId(
          `consent-history-event-${firstPage.events[0].event_id}`,
        ),
      ).toBeInTheDocument();
    });
    expect(screen.getAllByText('Profile storage').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('profile_storage')).toBeNull();
  });

  it('loads a second page and forwards the opaque cursor verbatim', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse(secondPage));

    render(<ConsentHistoryPanel talentId={TALENT_ID} />);

    const loadMore = await screen.findByTestId('consent-history-load-more');
    fireEvent.click(loadMore);

    await waitFor(() => {
      expect(
        screen.getByTestId(
          `consent-history-event-${secondPage.events[0].event_id}`,
        ),
      ).toBeInTheDocument();
    });

    // First request: no cursor query. Second: cursor= passed verbatim.
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      `/v1/consent/history/${TALENT_ID}`,
    );
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
      `/v1/consent/history/${TALENT_ID}?cursor=opaque-cursor-1`,
    );

    // After the second page, next_cursor is null → affordance hidden.
    expect(
      screen.queryByTestId('consent-history-load-more'),
    ).not.toBeInTheDocument();
  });

  it('hides the load-more affordance when next_cursor is null on first load', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(finalPage));
    render(<ConsentHistoryPanel talentId={TALENT_ID} />);

    await waitFor(() => {
      expect(
        screen.getByTestId(
          `consent-history-event-${firstPage.events[0].event_id}`,
        ),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByTestId('consent-history-load-more'),
    ).not.toBeInTheDocument();
  });

  it('renders the neutral anonymized state when is_anonymized:true', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        events: [],
        next_cursor: null,
        is_anonymized: true,
      }),
    );
    render(<ConsentHistoryPanel talentId={TALENT_ID} />);

    await waitFor(() => {
      expect(
        screen.getByTestId('consent-history-anonymized'),
      ).toBeInTheDocument();
    });
  });
});

// ATS-QA-1 I-1 D11 — expires_at is a Timestamptz instant: rendered via formatInstant, never raw ISO.
describe('ConsentHistoryPanel — expiry formatting (ATS-QA-1 D11)', () => {
  const EVENT_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a00';
  it('renders a non-null expires_at through the instant formatter, not as raw ISO', async () => {
    const expiresAt = '2027-04-29T15:45:00Z';
    const page: ConsentHistoryResponse = {
      events: [
        { event_id: EVENT_ID, scope: 'profile_storage', action: 'granted', created_at: '2026-04-29T00:00:00Z', expires_at: expiresAt },
      ],
      next_cursor: null,
      is_anonymized: false,
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(page));
    render(<ConsentHistoryPanel talentId={TALENT_ID} />);

    expect(await screen.findByText(new Date(expiresAt).toLocaleString())).toBeInTheDocument();
    expect(screen.queryByText(expiresAt)).toBeNull();
  });

  it('a null expires_at still renders the em dash', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(finalPage));
    render(<ConsentHistoryPanel talentId={TALENT_ID} />);
    await screen.findByTestId(`consent-history-event-${EVENT_ID}`);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });
});
