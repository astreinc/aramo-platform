import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ConsentView } from './ConsentView';
import type {
  ConsentDecisionLogResponse,
  ConsentHistoryResponse,
  TalentConsentStateResponse,
} from './types';

const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const TENANT_ID = '11111111-1111-7111-8111-111111111111';

const state: TalentConsentStateResponse = {
  talent_id: TALENT_ID,
  tenant_id: TENANT_ID,
  is_anonymized: false,
  computed_at: '2026-05-16T00:00:00Z',
  scopes: [],
};

const history: ConsentHistoryResponse = {
  events: [],
  next_cursor: null,
  is_anonymized: false,
};

const decisionLog: ConsentDecisionLogResponse = {
  entries: [],
  next_cursor: null,
  is_anonymized: false,
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ConsentView', () => {
  it('renders the three panels for the route talent_id', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith(`/v1/consent/state/`)) return jsonResponse(state);
      if (url.startsWith(`/v1/consent/history/`)) return jsonResponse(history);
      if (url.startsWith(`/v1/consent/decision-log/`)) {
        return jsonResponse(decisionLog);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={[`/consent/${TALENT_ID}`]}>
        <Routes>
          <Route path="/consent/:talentId" element={<ConsentView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('consent-state-panel')).toBeInTheDocument();
      expect(screen.getByTestId('consent-history-panel')).toBeInTheDocument();
      expect(
        screen.getByTestId('consent-decision-log-panel'),
      ).toBeInTheDocument();
    });
  });
});
