import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ConsentStatePanel } from './ConsentStatePanel';
import type { TalentConsentStateResponse } from './types';

const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const TENANT_ID = '11111111-1111-7111-8111-111111111111';

const baseResponse: TalentConsentStateResponse = {
  talent_id: TALENT_ID,
  tenant_id: TENANT_ID,
  is_anonymized: false,
  computed_at: '2026-05-16T00:00:00Z',
  scopes: [
    {
      scope: 'profile_storage',
      status: 'granted',
      granted_at: '2026-04-29T00:00:00Z',
      revoked_at: null,
      expires_at: null,
    },
    {
      scope: 'resume_processing',
      status: 'granted',
      granted_at: '2026-04-29T00:00:00Z',
      revoked_at: null,
      expires_at: null,
    },
    {
      scope: 'matching',
      status: 'revoked',
      granted_at: '2026-04-29T00:00:00Z',
      revoked_at: '2026-05-01T00:00:00Z',
      expires_at: null,
    },
    {
      scope: 'contacting',
      status: 'no_grant',
      granted_at: null,
      revoked_at: null,
      expires_at: null,
    },
    {
      scope: 'cross_tenant_visibility',
      status: 'no_grant',
      granted_at: null,
      revoked_at: null,
      expires_at: null,
    },
  ],
};

function mockFetch(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('ConsentStatePanel', () => {
  it('renders the 5 scopes with their per-scope status (no aggregation)', async () => {
    mockFetch(baseResponse);
    render(<ConsentStatePanel talentId={TALENT_ID} />);

    await waitFor(() => {
      expect(screen.getByTestId('consent-state-talent-id')).toHaveTextContent(
        TALENT_ID,
      );
    });
    expect(screen.getByTestId('consent-state-tenant-id')).toHaveTextContent(
      TENANT_ID,
    );
    expect(screen.getByTestId('consent-state-computed-at')).toHaveTextContent(
      '2026-05-16T00:00:00Z',
    );

    // All 5 scopes rendered individually — no aggregate "overall" row.
    for (const scope of [
      'profile_storage',
      'resume_processing',
      'matching',
      'contacting',
      'cross_tenant_visibility',
    ]) {
      expect(
        screen.getByTestId(`consent-state-scope-${scope}`),
      ).toBeInTheDocument();
    }

    // Per-scope statuses match the server response verbatim.
    expect(
      screen.getByTestId('consent-state-status-profile_storage'),
    ).toHaveTextContent('granted');
    expect(screen.getByTestId('consent-state-status-matching')).toHaveTextContent(
      'revoked',
    );
    expect(
      screen.getByTestId('consent-state-status-contacting'),
    ).toHaveTextContent('no_grant');
  });

  it('renders the neutral anonymized state when is_anonymized:true', async () => {
    mockFetch({ ...baseResponse, is_anonymized: true });
    render(<ConsentStatePanel talentId={TALENT_ID} />);

    await waitFor(() => {
      expect(
        screen.getByTestId('consent-state-anonymized'),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId('consent-state-status-profile_storage'),
    ).not.toBeInTheDocument();
  });
});
