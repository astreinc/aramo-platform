import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError, configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { errorMessage, nextSendTime, sendRefusalMessage, type BillingAccount, type SenderContext } from '../api';

import { AllowanceChip, PersonalAllowance } from './PersonalAllowance';

// Aramo Sign Personal (Free) — the workspace shows the Personal allowance (2 a
// day, 5 a month) and words every Personal send refusal clearly; a limit offers
// the Business route, never a charge.

vi.mock('../pdf', () => ({ loadPdf: vi.fn() }));

const SESSION = { sub: 'u1', consumer_type: 'sign', tenant_id: 't1', scopes: ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send'], iat: 0, exp: 9_999_999_999 };

const CTX: SenderContext = {
  user: { id: 'u1', email: 'pat@gmail.com', display_name: 'Pat Lee' },
  tenant: { id: 't1', name: 'Pat Lee', kind: 'PERSONAL' },
  workspace: 'personal',
  permissions: { read: true, create: true, send: true },
  can_send: true,
  personal_sending_enabled: true,
  organization_url: null,
  app_home_url: null,
};

function account(used: number, dayUsed: number): BillingAccount {
  return {
    subscription: null,
    allowance: {
      subscribed: true,
      plan_key: 'aramo-sign-free-personal-v1',
      allowance_key: 'esign.envelopes',
      limit: 5,
      used,
      remaining: 5 - used,
      period_start: '2026-10-01T00:00:00Z',
      period_end: '2026-11-01T00:00:00Z',
      threshold: used >= 5 ? 'EXHAUSTED' : 'OK',
      daily: { limit: 2, used: dayUsed },
    },
    billing_available: false,
    tenant_kind: 'PERSONAL',
    self_service_eligible: false,
    can_manage_billing: false,
  };
}

const SUMMARY = {
  counts: { draft: 0, sent: 0, in_progress: 0, completed: 0, declined: 0, voided: 0, expired: 0 },
  awaiting_signatures: 0,
  completed_this_month: 0,
  declined_or_expired: 0,
  months: [],
  completion_rate: null,
  expiring_soon: [],
  signing_window_days: 7,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const apiErr = (status: number, code: string, details: Record<string, unknown>) => new ApiError(status, 'refused', code, details);

describe('Personal allowance in the workspace', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('the Personal dashboard shows x of 2 today and y of 5 this month', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/sign/session')) return json(SESSION);
        if (url.endsWith('/v1/sign/sender/context')) return json(CTX);
        if (url.endsWith('/v1/sign/sender/summary')) return json(SUMMARY);
        if (url.endsWith('/v1/sign/billing/account')) return json(account(3, 1));
        return json({ items: [], counts: {} });
      }),
    );
    render(
      <MemoryRouter initialEntries={['/personal']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('personal-allowance-day')).toHaveTextContent('1 of 2 today');
    expect(screen.getByTestId('personal-allowance-chip')).toHaveTextContent('2 of 5 left this month · 1 of 2 left today');
    expect(screen.getByTestId('personal-allowance-month')).toHaveTextContent('3 of 5 this month');
    expect(screen.queryByTestId('personal-note')).toBeNull();
    expect(screen.queryByTestId('personal-upgrade')).toBeNull();
    expect(screen.getByRole('meter', { name: 'Envelopes sent today' })).toHaveAttribute('aria-valuenow', '1');
  });

  it('at the daily or monthly limit it says so and offers a Business organization', async () => {
    const { unmount } = render(<PersonalAllowance loader={() => Promise.resolve(account(2, 2))} />);
    expect(await screen.findByText('You’ve reached the limit for 24 hours. You can send again later.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create a Business organization' })).toHaveAttribute('href', '/signup');
    unmount();
    // The backend's next_available_at is shown as the exact time of the next send.
    const at = '2026-10-22T09:14:00Z';
    const withNext = account(2, 2);
    const allowance = withNext.allowance as { daily: { limit: number; used: number; next_available_at?: string } };
    allowance.daily.next_available_at = at;
    const second = render(<PersonalAllowance loader={() => Promise.resolve(withNext)} />);
    expect(await screen.findByText(`You’ve reached the limit for 24 hours. Your next send is available at ${nextSendTime(at)}.`)).toBeInTheDocument();
    second.unmount();
    render(<PersonalAllowance loader={() => Promise.resolve(account(5, 0))} />);
    expect(await screen.findByText('You’ve used all your envelopes for this month.')).toBeInTheDocument();
  });

  it('the chip reads "{n} of 5 left this month · {n} of 2 left today": green, amber at 0 today, red at 0 this month', () => {
    const { unmount } = render(<AllowanceChip used={2} limit={5} daily={{ used: 1, limit: 2 }} />);
    expect(screen.getByTestId('personal-allowance-chip')).toHaveTextContent('3 of 5 left this month · 1 of 2 left today');
    expect(screen.getByTestId('personal-allowance-chip')).toHaveAttribute('data-tone', 'green');
    unmount();
    const day = render(<AllowanceChip used={3} limit={5} daily={{ used: 2, limit: 2 }} />);
    expect(screen.getByTestId('personal-allowance-chip')).toHaveTextContent('2 of 5 left this month · 0 of 2 left today');
    expect(screen.getByTestId('personal-allowance-chip')).toHaveAttribute('data-tone', 'amber');
    day.unmount();
    render(<AllowanceChip used={5} limit={5} daily={{ used: 0, limit: 2 }} />);
    expect(screen.getByTestId('personal-allowance-chip')).toHaveTextContent(/^0 of 5 left this month$/);
    expect(screen.getByTestId('personal-allowance-chip')).toHaveAttribute('data-tone', 'red');
  });

  it('renders nothing without a sending subscription', async () => {
    const loader = vi.fn(() => Promise.resolve({ ...account(0, 0), allowance: { subscribed: false as const, allowance_key: 'esign.envelopes', state: 'NONE' as const } }));
    const { container } = render(<PersonalAllowance loader={loader} />);
    await waitFor(() => expect(loader).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['phone_verification_required', 'verified mobile phone number'],
    ['personal_review_pending', 'We’re reviewing your account'],
    ['personal_restricted', 'Sending is paused on your account'],
    ['personal_location_not_supported', 'currently available in the United States and India'],
  ])('send refusal %s has a clear message', (reason, text) => {
    expect(errorMessage(apiErr(403, 'INSUFFICIENT_PERMISSIONS', { reason }))).toContain(text);
  });

  it('daily and monthly limit refusals are worded for a Personal account', () => {
    expect(sendRefusalMessage(apiErr(409, 'ESIGN_ALLOWANCE_EXHAUSTED', { reason: 'DAILY_LIMIT_REACHED', limit: 2 }), true)).toBe(
      'You’ve sent 2 envelopes in the last 24 hours. You can send again later.',
    );
    const at = '2026-10-22T09:14:00Z';
    expect(sendRefusalMessage(apiErr(409, 'ESIGN_ALLOWANCE_EXHAUSTED', { reason: 'DAILY_LIMIT_REACHED', window: 'DAY', limit: 2, next_available_at: at }), true)).toBe(
      `You’ve sent 2 envelopes in the last 24 hours. Your next send is available at ${nextSendTime(at)}.`,
    );
    expect(nextSendTime(at)).not.toBeNull();
    expect(nextSendTime('not a time')).toBeNull();
    expect(nextSendTime(null)).toBeNull();
    expect(sendRefusalMessage(apiErr(409, 'ESIGN_ALLOWANCE_EXHAUSTED', { reason: 'LIMIT_REACHED', limit: 5, period_end: '2026-11-01T00:00:00Z' }), true)).toContain(
      'You’ve used all 5 envelopes this month on your Free personal account',
    );
    // An organization keeps its existing wording.
    expect(sendRefusalMessage(apiErr(409, 'ESIGN_ALLOWANCE_EXHAUSTED', { reason: 'LIMIT_REACHED', limit: 5 }), false)).toContain('billing period');
  });
});

describe('Personal send refusal in the wizard', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('a limit refusal on Send offers Create a Business organization', async () => {
    const env = {
      id: 'e1',
      subject: 'Lease',
      status: 'DRAFT',
      created_at: '2026-10-01T00:00:00Z',
      sent_at: null,
      completed_at: null,
      declined_at: null,
      voided_at: null,
      expires_at: null,
      signing_window_days: 7,
      sender: { id: 'u1', name: 'Pat Lee' },
      editable: true,
      documents: [{ id: 'd1', title: 'Lease', ordinal: 0, content_type: 'application/pdf', byte_size: 10, source_sha256: 'x', field_count: 1 }],
      recipients: [{ id: 's1', name: 'Sam', email: 'sam@x.test', status: 'PENDING', signing_order: 1, viewed_at: null, signed_at: null, declined_at: null, decline_reason: null }],
      fields: [{ id: 'f1', envelope_document_id: 'd1', signer_id: 's1', field_type: 'SIGNATURE', page_number: 0, x: 1, y: 1, width: 10, height: 10, required: true }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/sign/session')) return json(SESSION);
        if (url.endsWith('/v1/sign/sender/context')) return json(CTX);
        if (url.endsWith('/v1/sign/sender/summary')) return json(SUMMARY);
        if (url.endsWith('/envelopes/e1/send'))
          return json({ error: { code: 'ESIGN_ALLOWANCE_EXHAUSTED', message: 'limit', details: { reason: 'DAILY_LIMIT_REACHED', limit: 2 } } }, 409);
        if (url.endsWith('/envelopes/e1')) return json(env);
        return json({ items: [], counts: {} });
      }),
    );
    render(
      <MemoryRouter initialEntries={['/personal/envelopes/e1/edit?step=4']}>
        <App />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByTestId('send-envelope'));
    expect(await screen.findByText('You’ve sent 2 envelopes in the last 24 hours. You can send again later.')).toBeInTheDocument();
    expect(screen.getByTestId('personal-upgrade')).toHaveTextContent('Create a Business organization');
  });
});
