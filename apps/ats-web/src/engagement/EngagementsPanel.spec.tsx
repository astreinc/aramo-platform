import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EngagementsPanel } from './EngagementsPanel';
import type { EngagementView } from './types';

function makeEngagement(
  overrides: Partial<EngagementView> = {},
): EngagementView {
  return {
    id: 'eng-1',
    tenant_id: 't',
    talent_id: 'tal-1',
    requisition_id: 'req-1',
    examination_id: null,
    state: 'engaged',
    created_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

type FetchMap = Record<string, unknown | { status: number; body: unknown }>;

function installFetch(map: FetchMap) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    for (const [pattern, value] of Object.entries(map)) {
      if (url.includes(pattern)) {
        const isWrapped =
          typeof value === 'object' &&
          value !== null &&
          'status' in value &&
          'body' in value;
        const body = isWrapped ? (value as { body: unknown }).body : value;
        const status = isWrapped ? (value as { status: number }).status : 200;
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <EngagementsPanel talentId="tal-1" />
    </MemoryRouter>,
  );
}

describe('EngagementsPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches engagements filtered on talent_id (NOT talent_record_id)', async () => {
    installFetch({
      '/v1/engagements': { items: [makeEngagement()] },
      '/v1/requisitions/req-1': { title: 'Senior Engineer' },
    });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    // State label rendered.
    expect(screen.getByText(/Engaged/)).toBeInTheDocument();
    // Row links to the engagement-detail view.
    const link = screen.getByRole('link', { name: 'Senior Engineer' });
    expect(link).toHaveAttribute('href', '/engagements/eng-1');
    // The list filter used talent_id.
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const listCall = calls.find((c) => String(c[0]).includes('/v1/engagements'));
    const url = String(listCall?.[0]);
    expect(url).toContain('talent_id=tal-1');
    expect(url).not.toContain('talent_record_id');
  });

  it('falls back to the requisition id when the title fetch fails (graceful N+1)', async () => {
    installFetch({
      '/v1/engagements': { items: [makeEngagement()] },
      '/v1/requisitions/req-1': { status: 403, body: { message: 'no' } },
    });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'req-1' })).toBeInTheDocument(),
    );
  });

  it('renders the honest empty-state', async () => {
    installFetch({ '/v1/engagements': { items: [] } });
    renderPanel();
    await waitFor(() =>
      expect(
        screen.getByText(/not on any engagement yet/i),
      ).toBeInTheDocument(),
    );
  });

  it('surfaces the error message when the list fetch 403s', async () => {
    installFetch({
      '/v1/engagements': { status: 403, body: { message: 'no' } },
    });
    renderPanel();
    await waitFor(() =>
      expect(
        screen.getByText(/permission to view engagements/i),
      ).toBeInTheDocument(),
    );
  });
});
