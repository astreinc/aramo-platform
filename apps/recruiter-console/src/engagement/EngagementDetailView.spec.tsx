import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@aramo/fe-foundation';

import { EngagementDetailView } from './EngagementDetailView';
import type { EngagementEventView, EngagementView } from './types';

function makeSession(scopes: string[]): Session {
  return {
    sub: 'u1',
    consumer_type: 'recruiter',
    tenant_id: 't',
    scopes,
    iat: 0,
    exp: 0,
  };
}

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

function makeEvent(
  id: string,
  event_type: EngagementEventView['event_type'],
  event_payload: unknown,
): EngagementEventView {
  return {
    id,
    tenant_id: 't',
    engagement_id: 'eng-1',
    event_type,
    event_payload,
    created_at: '2026-06-02T00:00:00Z',
  };
}

type FetchMap = Record<string, unknown | { status: number; body: unknown }>;

// NOTE: patterns are matched by url.includes in INSERTION ORDER — the more
// specific sub-routes (/transitions, /events, …) MUST precede the bare
// /v1/engagements/eng-1 GET so they win.
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

function baseMap(events: EngagementEventView[], extra: FetchMap = {}): FetchMap {
  return {
    '/v1/engagements/eng-1/transitions': {
      engagement: makeEngagement({ state: 'awaiting_response' }),
    },
    '/v1/engagements/eng-1/response': {
      engagement: makeEngagement({ state: 'responded' }),
      response_event: makeEvent('ev-resp', 'response_received', {}),
    },
    '/v1/engagements/eng-1/conversation': {
      engagement: makeEngagement({ state: 'in_conversation' }),
      conversation_event: makeEvent('ev-conv', 'conversation_started', {}),
    },
    '/v1/engagements/eng-1/events': { events },
    '/v1/engagements/eng-1': makeEngagement(),
    '/v1/talent-records/tal-1': { id: 'tal-1', first_name: 'Ada', last_name: 'Lovelace' },
    '/v1/requisitions/req-1': { title: 'Senior Engineer' },
    ...extra,
  };
}

function renderAt(session: Session) {
  return render(
    <MemoryRouter initialEntries={['/engagements/eng-1']}>
      <Routes>
        <Route
          path="/engagements/:engagementId"
          element={<EngagementDetailView sessionOverride={session} />}
        />
        <Route path="/talent/:talentId" element={<p>Talent detail</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const fetchCalls = () =>
  (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;

describe('EngagementDetailView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the IDs-only header via the N+1 (talent name + requisition title + state)', async () => {
    installFetch(baseMap([]));
    renderAt(makeSession(['engagement:read']));
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    // State label + requisition title in the header description.
    expect(screen.getByText(/Engaged · Senior Engineer/)).toBeInTheDocument();
  });

  it('a read-only actor sees the event log but no controls (scope-gating)', async () => {
    installFetch(
      baseMap([makeEvent('e1', 'state_transition', { from_state: null, to_state: 'surfaced' })]),
    );
    renderAt(makeSession(['engagement:read']));
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { name: 'Event log' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Move engagement' }),
    ).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'Record a response' }),
    ).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'Record a conversation' }),
    ).toBeNull();
  });

  it('a write actor sees all controls and the event log renders the 5 types', async () => {
    installFetch(
      baseMap([
        makeEvent('e1', 'state_transition', { from_state: 'engaged', to_state: 'awaiting_response' }),
        makeEvent('e2', 'outreach_drafted', { draft_text: 'Hi there draft' }),
        makeEvent('e3', 'outreach_sent', { final_text: 'Hi there sent' }),
        makeEvent('e4', 'response_received', { response_received_at: '2026-06-03T00:00:00Z' }),
        makeEvent('e5', 'conversation_started', { conversation_started_at: '2026-06-04T00:00:00Z' }),
      ]),
    );
    renderAt(makeSession(['engagement:read', 'engagement:write']));
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { name: 'Move engagement' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Record a response' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Record a conversation' })).toBeInTheDocument();
    // Event-type labels + the outreach text (editable trail) render.
    expect(screen.getByText('Outreach sent')).toBeInTheDocument();
    expect(screen.getByText('Hi there sent')).toBeInTheDocument();
    expect(screen.getByText('Response received')).toBeInTheDocument();
    // state_transition summary.
    expect(screen.getByText('Engaged → Awaiting response')).toBeInTheDocument();
  });

  it('the response logger is a PICKER of outreach_sent events only (RULING 3)', async () => {
    installFetch(
      baseMap([
        makeEvent('ev-draft', 'outreach_drafted', { draft_text: 'draft' }),
        makeEvent('ev-sent', 'outreach_sent', { final_text: 'sent' }),
      ]),
    );
    renderAt(makeSession(['engagement:read', 'engagement:write']));
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    const select = screen.getByRole('combobox');
    const options = within(select).getAllByRole('option');
    // placeholder + exactly one outreach_sent option (the draft is excluded).
    expect(options).toHaveLength(2);
    expect(
      within(select).getByRole('option', { name: /Outreach sent/ }),
    ).toBeInTheDocument();
    expect((options[1] as HTMLOptionElement).value).toBe('ev-sent');
  });

  it('a transition POSTs { to_state, event_id } with an Idempotency-Key header', async () => {
    installFetch(baseMap([]));
    renderAt(makeSession(['engagement:read', 'engagement:write']));
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Awaiting response' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }));

    await waitFor(() =>
      expect(
        fetchCalls().find((c) => String(c[0]).includes('/transitions')),
      ).toBeDefined(),
    );
    const call = fetchCalls().find((c) => String(c[0]).includes('/transitions'));
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body.to_state).toBe('awaiting_response');
    expect(typeof body.event_id).toBe('string');
    expect(body.event_id.length).toBeGreaterThan(0);
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeTruthy();
  });

  it('the conversation logger POSTs conversation_started_at with an Idempotency-Key', async () => {
    installFetch(baseMap([]));
    renderAt(makeSession(['engagement:read', 'engagement:write']));
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    const button = screen.getByRole('button', { name: 'Record conversation' });
    const form = button.closest('form');
    const input = form?.querySelector('input[type="datetime-local"]');
    expect(input).not.toBeNull();
    fireEvent.change(input as Element, {
      target: { value: '2026-06-09T14:30' },
    });
    fireEvent.click(button);

    await waitFor(() =>
      expect(
        fetchCalls().find((c) => String(c[0]).includes('/conversation')),
      ).toBeDefined(),
    );
    const call = fetchCalls().find((c) => String(c[0]).includes('/conversation'));
    const init = call?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(typeof body.conversation_started_at).toBe('string');
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeTruthy();
  });

  it('surfaces the detail error when the engagement fetch 404s', async () => {
    installFetch({
      '/v1/engagements/eng-1': { status: 404, body: { message: 'no' } },
    });
    renderAt(makeSession(['engagement:read']));
    await waitFor(() =>
      expect(
        screen.getByText(/this engagement is not available/i),
      ).toBeInTheDocument(),
    );
  });
});
