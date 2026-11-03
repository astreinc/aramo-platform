import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContactHistorySection } from './ContactHistorySection';

// CONTACTS-1 §8 — the contact drawer's history section: the read-only list
// (type, summary, actor, time), the activity:create-gated add affordance, and
// the deleted-contact refusal message.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function activity(over: Record<string, unknown> = {}) {
  return {
    id: 'a-1', tenant_id: 't', site_id: null,
    type: 'call', subject_type: 'contact', subject_id: 'ct-1',
    notes: 'Discussed Q1 hiring plan', created_by_id: 'u-1',
    created_at: '2026-11-01T15:00:00Z',
    redacted_at: null, redacted_by: null,
    redaction_reason_code: null, redaction_reason: null,
    category: null, visibility: null, body_format: null,
    is_pinned: false, pinned_at: null, pinned_by_id: null,
    ...over,
  };
}

interface FetchOpts {
  readonly scopes?: readonly string[];
  readonly items?: readonly unknown[];
  readonly listStatus?: number;
  readonly postResponse?: Response;
}

function installFetch(opts: FetchOpts = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    if (url.includes('/session')) {
      return json({ sub: 'u-1', tenant_id: 't', scopes: opts.scopes ?? ['activity:read'] });
    }
    if (url.includes('/v1/tenant/users/directory')) {
      return json({ items: [{ user_id: 'u-1', display_name: 'Riley Chen' }] });
    }
    if (url.includes('/v1/activities') && method === 'POST') {
      return opts.postResponse ?? json(activity({ id: 'a-2' }), 201);
    }
    if (url.includes('/v1/activities')) {
      if (opts.listStatus !== undefined && opts.listStatus !== 200) {
        return json({ error: { code: 'INSUFFICIENT_PERMISSIONS', message: 'no' } }, opts.listStatus);
      }
      return json({ items: opts.items ?? [] });
    }
    return json({});
  });
  return calls;
}

describe('ContactHistorySection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists the contact history by subject with type, summary, actor and time', async () => {
    const calls = installFetch({
      items: [
        activity(),
        activity({ id: 'a-0', type: 'note', notes: 'Prefers email', created_at: '2026-10-30T09:00:00Z' }),
      ],
    });
    render(<ContactHistorySection contactId="ct-1" />);
    const row = await screen.findByTestId('contact-history-a-1');
    expect(row).toHaveTextContent('Call');
    expect(row).toHaveTextContent('Discussed Q1 hiring plan');
    await waitFor(() => expect(row).toHaveTextContent('Riley Chen'));
    expect(row.querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-01T15:00:00Z');
    // Newest first.
    const rows = screen.getAllByTestId(/^contact-history-a-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'contact-history-a-1',
      'contact-history-a-0',
    ]);
    const list = calls.find((c) => c.url.includes('/v1/activities'));
    expect(list?.url).toContain('subject_type=contact');
    expect(list?.url).toContain('subject_id=ct-1');
  });

  it('shows an empty state and no add affordance without activity:create', async () => {
    installFetch();
    render(<ContactHistorySection contactId="ct-1" />);
    expect(await screen.findByText('No activity recorded for this contact yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('contact-history-add')).not.toBeInTheDocument();
  });

  it('a redacted note shows the removal label, never a body', async () => {
    installFetch({
      items: [activity({ type: 'note', notes: null, redacted_at: '2026-11-01T16:00:00Z' })],
    });
    render(<ContactHistorySection contactId="ct-1" />);
    const row = await screen.findByTestId('contact-history-a-1');
    expect(row).toHaveTextContent('Note removed by a user');
  });

  it('a 403 on the read shows a permission message', async () => {
    installFetch({ listStatus: 403 });
    render(<ContactHistorySection contactId="ct-1" />);
    expect(
      await screen.findByText('You do not have permission to view this contact’s history.'),
    ).toBeInTheDocument();
  });

  it('records a call against the contact and reloads the list', async () => {
    const calls = installFetch({ scopes: ['activity:read', 'activity:create'] });
    render(<ContactHistorySection contactId="ct-1" />);
    await screen.findByTestId('contact-history-add');
    fireEvent.change(screen.getByLabelText('Activity type'), { target: { value: 'call' } });
    fireEvent.change(screen.getByLabelText('Activity details'), {
      target: { value: '  Left a voicemail  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add call' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({
      type: 'call',
      subject_type: 'contact',
      subject_id: 'ct-1',
      notes: 'Left a voicemail',
    });
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'GET' && c.url.includes('/v1/activities'))).toHaveLength(2),
    );
    expect((screen.getByLabelText('Activity details') as HTMLTextAreaElement).value).toBe('');
  });

  it('a deleted contact refusal (CONTACT_DELETED) is explained', async () => {
    installFetch({
      scopes: ['activity:read', 'activity:create'],
      postResponse: json(
        { error: { code: 'CONTACT_DELETED', message: 'deleted', details: { contact_id: 'ct-1' } } },
        422,
      ),
    });
    render(<ContactHistorySection contactId="ct-1" />);
    await screen.findByTestId('contact-history-add');
    fireEvent.change(screen.getByLabelText('Activity details'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(
      await screen.findByText('This contact has been deleted. Restore it to record activity.'),
    ).toBeInTheDocument();
  });

  it('the add button is disabled until there is text', async () => {
    installFetch({ scopes: ['activity:read', 'activity:create'] });
    render(<ContactHistorySection contactId="ct-1" />);
    await screen.findByTestId('contact-history-add');
    expect(screen.getByRole('button', { name: 'Add note' })).toBeDisabled();
  });
});
