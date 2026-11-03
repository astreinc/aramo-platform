import { ApiError } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboxItem } from '../api';

// W2 Inbox Discovery (LOCKED Gate-5 plan A3.2, A3.4, A5 rows 1-9) at the web client:
// discovered items render exactly like added ones, an "upcoming" item shows under
// Upcoming (never To sign), a done item leaves To sign, terminal items sit under
// Completed / Other, and a changed discovered item reloads the inbox once.

const list = vi.fn();
const sign = vi.fn();
const remove = vi.fn();
vi.mock('../api', async (orig) => {
  const mod = await orig<typeof import('../api')>();
  return {
    ...mod,
    inboxApi: {
      ...mod.inboxApi,
      list: (...a: unknown[]) => list(...a),
      sign: (...a: unknown[]) => sign(...a),
      remove: (...a: unknown[]) => remove(...a),
    },
  };
});
const toast = vi.fn();
vi.mock('@aramo/fe-foundation', async (orig) => {
  const mod = await orig<typeof import('@aramo/fe-foundation')>();
  return { ...mod, useToast: () => ({ show: toast }) };
});

import { InboxPage } from './Inbox';

const HANDLE = 'AbCdEf0123456789_-opaque-handle-XYZ';

function item(id: string, over: Partial<InboxItem> = {}): InboxItem {
  return {
    id,
    source: 'bound',
    subject: `Agreement ${id}`,
    from: 'Acme',
    envelope_status: 'SENT',
    my_status: 'PENDING',
    sent_at: '2026-11-01T00:00:00Z',
    expires_at: '2026-11-20T00:00:00Z',
    completed_at: null,
    signed_at: null,
    can_sign: true,
    can_download: false,
    ...over,
  };
}
type Lists = { waiting: InboxItem[]; completed: InboxItem[]; other: InboxItem[] };
const lists = (over: Partial<Lists> = {}): Lists => ({ waiting: [], completed: [], other: [], ...over });

function show() {
  render(
    <MemoryRouter>
      <InboxPage embedded />
    </MemoryRouter>,
  );
}

afterEach(() => vi.clearAllMocks());

describe('Waiting for me — W2 inbox discovery', () => {
  it('renders a discovered item exactly like an added one and signs it by its opaque handle (rows 1, 3)', async () => {
    list.mockResolvedValue(lists({ waiting: [item('b1'), item(HANDLE, { source: 'discovered', subject: 'Discovered offer' })] }));
    sign.mockResolvedValue({ signing_url: 'https://sign.example/s/tok' });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    show();
    const toSign = await screen.findByTestId('inbox-waiting');
    const discovered = within(toSign).getByTestId(`inbox-row-${HANDLE}`);
    expect(within(discovered).getByText('Discovered offer')).toBeInTheDocument();
    expect(within(discovered).getByText(/^Sign by /)).toBeInTheDocument();
    fireEvent.click(within(discovered).getByRole('button', { name: 'Sign' }));
    await waitFor(() => expect(sign).toHaveBeenCalledWith(HANDLE));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://sign.example/s/tok'));
    // Remove deletes an added item only; a discovered item has nothing to remove.
    expect(within(discovered).queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(within(within(toSign).getByTestId('inbox-row-b1')).getByRole('button', { name: /Remove/ })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('shows an upcoming item under Upcoming with "Not your turn yet", never under To sign (row 4)', async () => {
    list.mockResolvedValue(lists({ waiting: [item('u1', { source: 'discovered', my_status: 'upcoming', can_sign: false, subject: 'Second signer' })] }));
    show();
    const upcoming = await screen.findByTestId('inbox-upcoming');
    expect(within(upcoming).getByText('Upcoming')).toBeInTheDocument();
    expect(within(upcoming).getByText('Second signer')).toBeInTheDocument();
    expect(within(upcoming).getByText('Not your turn yet')).toBeInTheDocument();
    expect(within(upcoming).queryByRole('button', { name: 'Sign' })).toBeNull();
    const toSign = screen.getByTestId('inbox-waiting');
    expect(within(toSign).queryByText('Second signer')).toBeNull();
    expect(within(toSign).getByText('Nothing is waiting for your signature.')).toBeInTheDocument();
  });

  it('moves the item to To sign once it is the user’s turn (row 4, after signer 1)', async () => {
    list.mockResolvedValue(lists({ waiting: [item('u1', { my_status: 'PENDING', can_sign: true, subject: 'Second signer' })] }));
    show();
    const toSign = await screen.findByTestId('inbox-waiting');
    expect(within(toSign).getByText('Second signer')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-upcoming')).toBeNull();
  });

  it('a signed item while others are pending is off To sign (rows 5, 6)', async () => {
    list.mockResolvedValue(
      lists({ other: [item('d1', { my_status: 'SIGNED', envelope_status: 'IN_PROGRESS', can_sign: false, signed_at: '2026-11-02T00:00:00Z', subject: 'Done by me' })] }),
    );
    show();
    const toSign = await screen.findByTestId('inbox-waiting');
    expect(within(toSign).queryByText('Done by me')).toBeNull();
    const other = screen.getByTestId('inbox-other');
    expect(within(other).getByText('Done by me')).toBeInTheDocument();
    expect(within(other).queryByRole('button', { name: 'Sign' })).toBeNull();
  });

  it('completed / voided / expired / declined are listed under Completed or Other and are not signable (row 7)', async () => {
    list.mockResolvedValue(
      lists({
        completed: [item('c1', { envelope_status: 'COMPLETED', my_status: 'SIGNED', can_sign: false, can_download: true, completed_at: '2026-11-02T00:00:00Z', subject: 'Done deal' })],
        other: [
          item('v1', { envelope_status: 'VOIDED', can_sign: false, subject: 'Voided one' }),
          item('e1', { envelope_status: 'EXPIRED', can_sign: false, subject: 'Expired one' }),
          item('x1', { envelope_status: 'DECLINED', my_status: 'DECLINED', can_sign: false, subject: 'Declined one' }),
        ],
      }),
    );
    show();
    const completed = await screen.findByTestId('inbox-completed');
    expect(within(completed).getByText('Done deal')).toBeInTheDocument();
    expect(within(completed).getByRole('button', { name: 'Signed copy' })).toBeInTheDocument();
    const other = screen.getByTestId('inbox-other');
    for (const s of ['Voided one', 'Expired one', 'Declined one']) expect(within(other).getByText(s)).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: 'Sign' })).toHaveLength(0);
  });

  it('an existing claimed item (no source field, older server) is listed once and signs by its binding id (rows 2, 8)', async () => {
    const legacy = item('bind-1');
    delete (legacy as Partial<InboxItem>).source;
    list.mockResolvedValue(lists({ waiting: [legacy] }));
    sign.mockResolvedValue({ signing_url: 'https://sign.example/s/tok2' });
    vi.stubGlobal('location', { ...window.location, assign: vi.fn() });
    show();
    const toSign = await screen.findByTestId('inbox-waiting');
    expect(within(toSign).getAllByText('Agreement bind-1')).toHaveLength(1);
    fireEvent.click(within(toSign).getByRole('button', { name: 'Sign' }));
    await waitFor(() => expect(sign).toHaveBeenCalledWith('bind-1'));
    vi.unstubAllGlobals();
  });

  it('a changed discovered item (404 inbox_item_not_found) says so and reloads the inbox once', async () => {
    list.mockResolvedValueOnce(lists({ waiting: [item(HANDLE, { source: 'discovered' })] })).mockResolvedValueOnce(lists());
    sign.mockRejectedValue(new ApiError(404, 'Not in your inbox', 'NOT_FOUND', { reason: 'inbox_item_not_found' }));
    show();
    const row = await screen.findByTestId(`inbox-row-${HANDLE}`);
    fireEvent.click(within(row).getByRole('button', { name: 'Sign' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('This item changed. Showing your latest inbox.'));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(sign).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId(`inbox-row-${HANDLE}`)).toBeNull());
  });

  it('a revalidation refusal keeps today’s message and does not reload', async () => {
    list.mockResolvedValue(lists({ waiting: [item(HANDLE, { source: 'discovered' })] }));
    sign.mockRejectedValue(new ApiError(409, 'It is not your turn', 'ENVELOPE_ILLEGAL_TRANSITION', { reason: 'not_your_turn' }));
    show();
    const row = await screen.findByTestId(`inbox-row-${HANDLE}`);
    fireEvent.click(within(row).getByRole('button', { name: 'Sign' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast).not.toHaveBeenCalledWith('This item changed. Showing your latest inbox.');
    expect(list).toHaveBeenCalledTimes(1);
  });
});
