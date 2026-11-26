import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { NO_SENDER_ACTIONS } from '@aramo/sign-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnvelopeDetail as Detail, SenderContext } from '../api';
import { WorkspaceProvider } from '../workspace';

import { EnvelopeDetail } from './EnvelopeDetail';

// UAT SND-14 (field-test batch 1 §4 SND-3) — a refused reminder, end to end on web: the real
// apiClient reads the server's 429 body, errorMessage turns it into the shared words, and the
// workspace toast shows them. Only fetch is stubbed; the body is the one sign-service sends
// (senderHttp ReminderLimitError → AramoExceptionFilter envelope).

vi.mock('@aramo/document-templates-web/pdf', async (importOriginal) => ({ ...(await importOriginal<object>()), loadPdf: vi.fn() }));

const CTX: SenderContext = {
  user: { id: 'u-1', email: 'pat@example.com', display_name: 'Pat Lee' },
  tenant: { id: 't1', name: 'Acme', kind: 'BUSINESS' },
  workspace: 'sign',
  permissions: { read: true, create: true, send: true },
  can_send: true,
  organization_url: null,
  app_home_url: null,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const RETRY_AT = '2026-11-19T15:30:00.000Z';
function envelope(reminder_available_at: string | null): Detail {
  return {
    id: 'env-1', subject: 'Agreement', status: 'IN_PROGRESS', created_at: '2026-11-19T14:00:00Z', sent_at: '2026-11-19T14:00:00Z', completed_at: null, declined_at: null, voided_at: null,
    expires_at: null, signing_window_days: 30, sender: { id: 'u-1', name: 'Pat Lee' }, editable: false, documents: [], fields: [], routing_mode: 'PARALLEL', next_signer_id: null,
    recipients: [
      { id: 's1', name: 'Sam Signer', email: 's1@example.com', status: 'PENDING', signing_order: 1, viewed_at: null, signed_at: null, declined_at: null, decline_reason: null, can_remind: true, reminder_available_at },
    ],
    actions: { ...NO_SENDER_ACTIONS, remind: true, void: true },
  } as Detail;
}
const REFUSED = {
  error: {
    code: 'ESIGN_REMINDER_NOT_ALLOWED',
    message: 'This signer was reminded less than an hour ago',
    request_id: 'req-1',
    details: { reason: 'reminder_cooldown', retry_after_seconds: 3000, retry_at: RETRY_AT },
  },
};

function stub(detail: Detail, remind: () => Response) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/remind') && init?.method === 'POST') return remind();
    if (u.endsWith('/events')) return json({ items: [] });
    if (u.includes('/envelopes/env-1')) return json(detail);
    return json({ awaiting_signatures: 0 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function show() {
  render(
    <MemoryRouter initialEntries={['/sign/envelopes/env-1']}>
      <WorkspaceProvider ctx={CTX}>
        <Routes>
          <Route path="/sign/envelopes/:id" element={<EnvelopeDetail />} />
        </Routes>
      </WorkspaceProvider>
    </MemoryRouter>,
  );
}

const toastText = () => screen.queryAllByRole('status').map((n) => n.textContent ?? '');

describe('EnvelopeDetail — a refused reminder shows the shared words (SND-3)', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('a 429 reminder_cooldown toasts "… You can send another reminder at {time}."', async () => {
    const fetchMock = stub(envelope(null), () => json(REFUSED, 429));
    show();
    fireEvent.click(await screen.findByTestId('remind-s1'));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/remind'))).toBe(true));
    await waitFor(() =>
      expect(toastText()).toContainEqual(expect.stringMatching(/^This signer was reminded less than an hour ago\. You can send another reminder at .+\.$/)),
    );
  });

  // The web defect behind "repeated clicks show nothing": the workspace toast kept the message as
  // plain state, so the same words again were an unchanged state — no new showing, and the earlier
  // 3-second timer removed them, at worst right after the click. Each toast() is now its own showing.
  it('a second refused click shows the words again for the full 3 seconds', async () => {
    const fetchMock = stub(envelope(null), () => json(REFUSED, 429));
    show();
    const remindCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/remind')).length;
    const words = /^This signer was reminded less than an hour ago\. You can send another reminder at .+\.$/;
    fireEvent.click(await screen.findByTestId('remind-s1'));
    await waitFor(() => expect(toastText()).toContainEqual(expect.stringMatching(words)));
    await new Promise((r) => setTimeout(r, 2000));
    await waitFor(() => expect(screen.getByTestId('remind-s1')).toBeEnabled());
    fireEvent.click(screen.getByTestId('remind-s1'));
    await waitFor(() => expect(remindCalls()).toBe(2));
    // 3.5 s after the first refusal, 1.5 s after the second: still showing.
    await new Promise((r) => setTimeout(r, 1500));
    expect(toastText()).toContainEqual(expect.stringMatching(words));
  }, 10_000);
});
