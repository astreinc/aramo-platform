import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ConsentDecisionLogPanel } from './ConsentDecisionLogPanel';
import type { ConsentDecisionLogResponse } from './types';

const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

const firstPage: ConsentDecisionLogResponse = {
  entries: [
    {
      event_id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a00',
      talent_id: TALENT_ID,
      event_type: 'consent.grant.recorded',
      created_at: '2026-04-29T00:00:00Z',
      actor_id: null,
      actor_type: 'recruiter',
      event_payload: { scope: 'profile_storage' },
    },
  ],
  next_cursor: null,
  is_anonymized: false,
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ConsentDecisionLogPanel', () => {
  it('renders the first page of decision-log entries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(firstPage));
    render(<ConsentDecisionLogPanel talentId={TALENT_ID} />);

    await waitFor(() => {
      expect(
        screen.getByTestId(
          `consent-decision-log-entry-${firstPage.entries[0].event_id}`,
        ),
      ).toBeInTheDocument();
    });
  });

  it('renders the neutral anonymized state when is_anonymized:true', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        entries: [],
        next_cursor: null,
        is_anonymized: true,
      }),
    );
    render(<ConsentDecisionLogPanel talentId={TALENT_ID} />);

    await waitFor(() => {
      expect(
        screen.getByTestId('consent-decision-log-anonymized'),
      ).toBeInTheDocument();
    });
  });
});
