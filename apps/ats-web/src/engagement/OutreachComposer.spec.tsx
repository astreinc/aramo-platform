import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OutreachComposer } from './OutreachComposer';
import type { EngagementState } from './types';

// The composer's 6 required proofs (§6 / Amendment v1.1). R5-corrected spec
// hygiene: per-call mockImplementation returning a FRESH Response each time,
// waitFor the post-fetch signal first, MemoryRouter wrap (the composer uses
// no router hooks but the precedent wraps for parity).

const DRAFT = '/v1/engagements/eng-1/outreach/draft';
const SEND = '/v1/engagements/eng-1/outreach/send';

interface Stub {
  readonly status?: number;
  readonly body: unknown;
}

function jsonResponse({ status = 200, body }: Stub): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Installs a fetch that returns a FRESH Response per call (a Response body is
// single-use — reusing one across calls throws "Body already read").
function installFetch(routes: Record<string, Stub>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    for (const [pattern, stub] of Object.entries(routes)) {
      if (url.includes(pattern)) return jsonResponse(stub);
    }
    return jsonResponse({ status: 404, body: { error: { code: 'NOT_FOUND' } } });
  });
}

const fetchCalls = () =>
  (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;

const callsTo = (fragment: string) =>
  fetchCalls().filter((c) => String(c[0]).includes(fragment));

function idemKey(call: unknown[]): string {
  const init = call[1] as RequestInit;
  return (init.headers as Record<string, string>)['Idempotency-Key'];
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body));
}

const onSent = vi.fn();

function renderComposer(state: EngagementState = 'engaged') {
  return render(
    <MemoryRouter>
      <OutreachComposer engagementId="eng-1" state={state} onSent={onSent} />
    </MemoryRouter>,
  );
}

function draftResponse(overrides: Record<string, unknown> = {}) {
  return {
    draft_event_id: '11111111-1111-4111-8111-111111111111',
    draft_text: 'AI-generated draft text',
    ai_draft_audit_record_id: 'audit-1',
    ...overrides,
  };
}

async function generate(prompt = 'Reach out about the staff role') {
  fireEvent.change(screen.getByLabelText('Outreach prompt'), {
    target: { value: prompt },
  });
  fireEvent.click(
    screen.getByRole('button', { name: /generate draft|re-generate draft/i }),
  );
}

describe('OutreachComposer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    onSent.mockReset();
  });

  it('PROOF 1 — draft renders the returned text in an editable field; NO delivery occurs at draft', async () => {
    installFetch({ [DRAFT]: { body: draftResponse() } });
    renderComposer('engaged');
    await generate();

    const final = await screen.findByLabelText('Final message');
    expect((final as HTMLTextAreaElement).value).toBe('AI-generated draft text');
    // Editable — a change is reflected.
    fireEvent.change(final, { target: { value: 'tweaked' } });
    expect((final as HTMLTextAreaElement).value).toBe('tweaked');
    // The DeliveryProvider is NOT hit at draft — no send call occurred.
    expect(callsTo('/outreach/send')).toHaveLength(0);
  });

  it('PROOF 2 — a soft consent_warning surfaces NON-blocking (the draft still succeeds)', async () => {
    installFetch({
      [DRAFT]: {
        body: draftResponse({
          consent_warning: {
            reason_code: 'no_consent_on_file',
            display_message: 'Consent is not currently granted — review before sending.',
          },
        }),
      },
    });
    renderComposer('engaged');
    await generate();

    // The warning shows AND the editable preview still renders (draft worked).
    expect(
      await screen.findByText(/consent is not currently granted/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Final message')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Send outreach' }),
    ).toBeInTheDocument();
  });

  it('PROOF 3 — send POSTs the edited final_text (≠ draft_text — the editable trail)', async () => {
    installFetch({
      [DRAFT]: { body: draftResponse() },
      [SEND]: {
        body: {
          engagement: { id: 'eng-1', state: 'awaiting_response' },
          outreach_event: { id: 'ev-sent' },
          delivery_id: 'del-1',
        },
      },
    });
    renderComposer('engaged');
    await generate();

    const final = await screen.findByLabelText('Final message');
    fireEvent.change(final, { target: { value: 'Recruiter-edited message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send outreach' }));

    await waitFor(() => expect(callsTo('/outreach/send')).toHaveLength(1));
    const body = bodyOf(callsTo('/outreach/send')[0]);
    expect(body.final_text).toBe('Recruiter-edited message');
    expect(body.final_text).not.toBe('AI-generated draft text');
    expect(body.draft_event_id).toBe('11111111-1111-4111-8111-111111111111');
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  });

  it('PROOF 4 — the binding 403 CONSENT_NOT_GRANTED_AT_SEND surfaces and is NON-overridable', async () => {
    installFetch({
      [DRAFT]: { body: draftResponse() },
      [SEND]: {
        status: 403,
        body: { error: { code: 'CONSENT_NOT_GRANTED_AT_SEND' } },
      },
    });
    renderComposer('engaged');
    await generate();

    fireEvent.click(await screen.findByRole('button', { name: 'Send outreach' }));

    expect(
      await screen.findByText(/consent is not granted for this talent/i),
    ).toBeInTheDocument();
    // NON-overridable: no override/force/send-anyway control is rendered.
    expect(
      screen.queryByRole('button', { name: /override|send anyway|force|ignore/i }),
    ).toBeNull();
  });

  it('PROOF 5 — engaged-gate: the draft action is hidden + the explanation shown when state !== engaged', () => {
    renderComposer('surfaced');
    expect(
      screen.getByText(/outreach can be drafted once the talent is engaged/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /generate draft/i }),
    ).toBeNull();
    expect(screen.queryByLabelText('Outreach prompt')).toBeNull();
  });

  it('PROOF 6 — the draft key RE-MINTS per generation; the send key is DERIVED from draft_event_id', async () => {
    installFetch({
      [DRAFT]: { body: draftResponse() },
      [SEND]: {
        body: {
          engagement: { id: 'eng-1', state: 'awaiting_response' },
          outreach_event: { id: 'ev-sent' },
          delivery_id: 'del-1',
        },
      },
    });
    renderComposer('engaged');

    // First generation.
    await generate('First prompt');
    await screen.findByLabelText('Final message');
    // Second generation (a re-draft of a changed prompt).
    await generate('Second, changed prompt');
    await waitFor(() => expect(callsTo('/outreach/draft')).toHaveLength(2));

    const draftCalls = callsTo('/outreach/draft');
    const key1 = idemKey(draftCalls[0]);
    const key2 = idemKey(draftCalls[1]);
    expect(key1).toBeTruthy();
    expect(key2).toBeTruthy();
    // RE-MINTED — a changed prompt is a new operation, never a replay.
    expect(key1).not.toBe(key2);

    // Now send — its key must be DERIVED from draft_event_id (stable across
    // retries → dedupes).
    fireEvent.click(screen.getByRole('button', { name: 'Send outreach' }));
    await waitFor(() => expect(callsTo('/outreach/send')).toHaveLength(1));
    expect(idemKey(callsTo('/outreach/send')[0])).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
  });
});
