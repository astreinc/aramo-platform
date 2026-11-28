import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { smsCertificationPending, type SenderContext } from '../api';
import {
  SMS_CERTIFICATION_WORDING,
  SMS_CONSENT_WORDING,
  SMS_SEND_NOTE,
  SMS_SIGNUP_STEP_TITLE,
} from '../sms-consent-copy';
import { SMS_SIGNUP_OFFER_KEY, markSmsSignupOffer } from '../sms-signup-offer';
import { WorkspaceProvider } from '../workspace';

import { SmsSignupStep, TextMessagesSection } from './TextMessages';

// SMS-CONSENT-1 §2 / §3 — the web screens: the organization's certification (owner / admin),
// the send-flow note, Settings → Text messages, and the optional step after signup. Every
// surface is hidden while the server says texts are not available.

vi.mock('@aramo/document-templates-web/pdf', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadPdf: vi.fn(),
}));

const SESSION = {
  sub: 'u1',
  consumer_type: 'sign',
  tenant_id: 't1',
  scopes: ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send'],
  iat: 0,
  exp: 9_999_999_999,
};

function ctx(over: Partial<SenderContext> = {}): SenderContext {
  return {
    user: { id: 'u1', email: 'priya@northwind.test', display_name: 'Priya Nair' },
    tenant: { id: 't1', name: 'Northwind Staffing', kind: 'BUSINESS' },
    workspace: 'sign',
    permissions: { read: true, create: true, send: true },
    can_send: true,
    personal_sending_enabled: false,
    organization_url: null,
    app_home_url: null,
    ...over,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const CERT_OFF = {
  available: true,
  required: true,
  certified: false,
  certified_at: null,
  certified_by_name: null,
  wording_version: '2026-11-28',
  wording: SMS_CERTIFICATION_WORDING,
};
const CERT_ON = {
  ...CERT_OFF,
  certified: true,
  certified_at: '2026-11-28T10:00:00Z',
  certified_by_name: 'Priya Nair',
};
const CONSENT_NONE = {
  available: true,
  phone_masked: null,
  phone_verified: false,
  consented: false,
  consented_at: null,
  wording_version: '2026-11-28',
  wording: SMS_CONSENT_WORDING,
};
const CONSENT_VERIFIED = { ...CONSENT_NONE, phone_masked: '+1••••••••23', phone_verified: true };
const CONSENT_ON = { ...CONSENT_VERIFIED, consented: true, consented_at: '2026-11-28T10:00:00Z' };

/** A fetch stub: `routes` answers by "METHOD path" (latest wins); everything else is {}. */
function stub(routes: Record<string, unknown | (() => unknown)>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const path =
        url.slice(url.indexOf('/v1/') >= 0 ? url.indexOf('/v1/') : 0).split('?')[0] ?? '';
      if (url.includes('/auth/sign/session')) return json(SESSION);
      calls.push({
        method,
        path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const hit = routes[`${method} ${path}`];
      if (hit !== undefined)
        return json(typeof hit === 'function' ? (hit as () => unknown)() : hit);
      return json({ items: [] });
    }),
  );
  return calls;
}

function inWorkspace(node: ReactNode, c: SenderContext = ctx()) {
  return render(
    <MemoryRouter>
      <WorkspaceProvider ctx={c}>{node}</WorkspaceProvider>
    </MemoryRouter>,
  );
}

const writes = (calls: Call[]) =>
  calls.filter((c) => c.method !== 'GET' && c.path.includes('sms-'));

describe('SMS-CONSENT-1 — organization certification (Settings → Text messages (SMS))', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('is hidden from the settings menu while texts are not available', async () => {
    const calls = stub({
      'GET /v1/sign/sender/context': ctx({ org_admin: true }),
      'GET /v1/sign/sender/sms-certification': { ...CERT_OFF, available: false },
    });
    render(
      <MemoryRouter initialEntries={['/sign/settings/sms']}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByTestId('settings-account');
    expect(calls.some((c) => c.path === '/v1/sign/sender/sms-certification')).toBe(true);
    expect(screen.queryByRole('link', { name: 'Text messages (SMS)' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('sms-certification')).not.toBeInTheDocument();
  });

  it('is not read for someone who is not an organization owner or admin', async () => {
    const calls = stub({
      'GET /v1/sign/sender/context': ctx({ org_admin: false }),
      'GET /v1/sign/sender/sms-certification': CERT_OFF,
    });
    render(
      <MemoryRouter initialEntries={['/sign/settings/personal']}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByTestId('settings-account');
    expect(screen.queryByRole('link', { name: 'Text messages (SMS)' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/v1/sign/sender/sms-certification')).toBe(false);
  });

  it('shows the wording and certifies only after the confirmation', async () => {
    let cert: unknown = CERT_OFF;
    const calls = stub({
      'GET /v1/sign/sender/context': ctx({ org_admin: true }),
      'GET /v1/sign/sender/sms-certification': () => cert,
      'POST /v1/sign/sender/sms-certification': () => {
        cert = CERT_ON;
        return CERT_ON;
      },
    });
    render(
      <MemoryRouter initialEntries={['/sign/settings/sms']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('sms-certification-wording')).toHaveTextContent(
      SMS_CERTIFICATION_WORDING,
    );
    expect(screen.getByRole('link', { name: 'Text messages (SMS)' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('sms-certification-certify'));
    expect(await screen.findByText('Confirm SMS consent?')).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);
    fireEvent.click(screen.getByTestId('sms-certification-confirm'));
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        {
          method: 'POST',
          path: '/v1/sign/sender/sms-certification',
          body: { wording_version: '2026-11-28' },
        },
      ]),
    );
    expect(await screen.findByTestId('sms-certification-by')).toHaveTextContent(
      'Confirmed by Priya Nair',
    );
  });

  it('withdraws only after the confirmation, with DELETE', async () => {
    let cert: unknown = CERT_ON;
    const calls = stub({
      'GET /v1/sign/sender/context': ctx({ org_admin: true }),
      'GET /v1/sign/sender/sms-certification': () => cert,
      'DELETE /v1/sign/sender/sms-certification': () => {
        cert = CERT_OFF;
        return CERT_OFF;
      },
    });
    render(
      <MemoryRouter initialEntries={['/sign/settings/sms']}>
        <App />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByTestId('sms-certification-withdraw'));
    expect(await screen.findByText('Withdraw SMS consent?')).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);
    fireEvent.click(screen.getByTestId('sms-certification-confirm'));
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        { method: 'DELETE', path: '/v1/sign/sender/sms-certification', body: undefined },
      ]),
    );
    expect(await screen.findByTestId('sms-certification-certify')).toBeInTheDocument();
  });
});

describe('SMS-CONSENT-1 — the send-flow note', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('is pending only when certification is required and not given', () => {
    expect(smsCertificationPending({})).toBe(false);
    expect(
      smsCertificationPending({ sms_certification: { required: false, certified: false } }),
    ).toBe(false);
    expect(
      smsCertificationPending({ sms_certification: { required: true, certified: true } }),
    ).toBe(false);
    expect(
      smsCertificationPending({ sms_certification: { required: true, certified: false } }),
    ).toBe(true);
  });

  const R1 = {
    id: 'r1',
    name: 'Alex Lee',
    email: 'alex@x.test',
    status: 'PENDING',
    signing_order: 1,
    recipient_kind: 'SIGNER',
    copy_delivery: null,
    assigned_to_me: false,
  };
  const ENV = {
    id: 'e9',
    subject: 'Choices',
    status: 'DRAFT',
    created_at: '2026-10-01T00:00:00Z',
    sent_at: null,
    completed_at: null,
    declined_at: null,
    voided_at: null,
    expires_at: null,
    signing_window_days: 7,
    sender: { id: 'u1', name: 'Priya Nair' },
    editable: true,
    routing_mode: 'PARALLEL',
    next_signer_id: null,
    allow_delegation: false,
    documents: [],
    recipients: [R1],
    fields: [],
  };

  function step2(c: SenderContext) {
    stub({
      'GET /v1/sign/sender/context': c,
      'GET /v1/sign/sender/envelopes/e9': ENV,
      'GET /v1/sign/sender/envelopes/e9/messaging': {
        envelope_id: 'e9',
        recipients: [],
        deliveries: [],
      },
    });
    render(
      <MemoryRouter initialEntries={['/sign/envelopes/e9/edit?step=2']}>
        <App />
      </MemoryRouter>,
    );
  }

  it('shows the note instead of the SMS options while the organization has not certified', async () => {
    step2(
      ctx({
        features: { sms_delivery: true, sms_otp: true },
        sms_certification: { required: true, certified: false },
      }),
    );
    expect(await screen.findByTestId('sms-certification-note')).toHaveTextContent(SMS_SEND_NOTE);
    expect(screen.queryByTestId('delivery-channel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sms-code')).not.toBeInTheDocument();
  });

  it('keeps the SMS options once certified, without the note', async () => {
    step2(
      ctx({
        features: { sms_delivery: true, sms_otp: true },
        sms_certification: { required: true, certified: true },
      }),
    );
    expect(await screen.findByTestId('delivery-channel')).toBeInTheDocument();
    expect(screen.getByTestId('sms-code')).toBeInTheDocument();
    expect(screen.queryByTestId('sms-certification-note')).not.toBeInTheDocument();
  });

  it('shows no note when certification is not required', async () => {
    step2(ctx());
    await screen.findAllByTestId('recipient-role');
    expect(screen.queryByTestId('sms-certification-note')).not.toBeInTheDocument();
  });
});

describe('SMS-CONSENT-1 — Settings → Text messages', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('renders nothing while texts are not available', async () => {
    const calls = stub({ 'GET /v1/sign/me/sms-consent': { ...CONSENT_NONE, available: false } });
    inWorkspace(<TextMessagesSection />);
    await waitFor(() => expect(calls.some((c) => c.path === '/v1/sign/me/sms-consent')).toBe(true));
    expect(screen.queryByTestId('settings-text-messages')).not.toBeInTheDocument();
  });

  it('verifies the number, then a separate unticked consent saves with the wording version and WEB', async () => {
    let consent: unknown = CONSENT_NONE;
    const calls = stub({
      'GET /v1/sign/me/sms-consent': () => consent,
      'POST /v1/sign/me/sms-consent/phone': { sent: true, phone_masked: '+1••••••••23' },
      'POST /v1/sign/me/sms-consent/verify': () => {
        consent = CONSENT_VERIFIED;
        return { verified: true };
      },
      'PUT /v1/sign/me/sms-consent': () => {
        consent = CONSENT_ON;
        return CONSENT_ON;
      },
    });
    inWorkspace(<TextMessagesSection />);
    fireEvent.change(await screen.findByTestId('sms-consent-phone'), {
      target: { value: '+14155550123' },
    });
    fireEvent.click(screen.getByTestId('sms-consent-send-code'));
    expect(await screen.findByText('We texted a code to +1••••••••23.')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('sms-consent-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('sms-consent-verify'));
    const box = (await screen.findByTestId('sms-consent-agree')) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByTestId('sms-consent-wording')).toHaveTextContent(SMS_CONSENT_WORDING);
    expect(screen.getByTestId('sms-consent-save')).toBeDisabled();
    fireEvent.click(box);
    fireEvent.click(screen.getByTestId('sms-consent-save'));
    expect(await screen.findByTestId('sms-consent-on')).toBeInTheDocument();
    expect(writes(calls)).toEqual([
      {
        method: 'POST',
        path: '/v1/sign/me/sms-consent/phone',
        body: { phone_e164: '+14155550123' },
      },
      { method: 'POST', path: '/v1/sign/me/sms-consent/verify', body: { code: '123456' } },
      {
        method: 'PUT',
        path: '/v1/sign/me/sms-consent',
        body: { consented: true, wording_version: '2026-11-28', channel: 'WEB' },
      },
    ]);
  });

  it('a number not in international format is not sent', async () => {
    const calls = stub({ 'GET /v1/sign/me/sms-consent': CONSENT_NONE });
    inWorkspace(<TextMessagesSection />);
    fireEvent.change(await screen.findByTestId('sms-consent-phone'), {
      target: { value: '415 555 0123' },
    });
    expect(screen.getByTestId('sms-consent-send-code')).toBeDisabled();
    expect(writes(calls)).toHaveLength(0);
  });

  it('Turn off saves consented false; Remove number deletes', async () => {
    const calls = stub({ 'GET /v1/sign/me/sms-consent': CONSENT_ON });
    inWorkspace(<TextMessagesSection />);
    fireEvent.click(await screen.findByTestId('sms-consent-turn-off'));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    fireEvent.click(screen.getByTestId('sms-consent-remove'));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)).toEqual([
      {
        method: 'PUT',
        path: '/v1/sign/me/sms-consent',
        body: { consented: false, wording_version: '2026-11-28', channel: 'WEB' },
      },
      { method: 'DELETE', path: '/v1/sign/me/sms-consent', body: undefined },
    ]);
  });
});

describe('SMS-CONSENT-1 — the optional step after signup', () => {
  beforeEach(() => {
    configureAuthConsumer('sign');
    window.localStorage.removeItem(SMS_SIGNUP_OFFER_KEY);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem(SMS_SIGNUP_OFFER_KEY);
  });

  it('is not shown (nor read) without a signup on this browser', () => {
    const calls = stub({ 'GET /v1/sign/me/sms-consent': CONSENT_NONE });
    inWorkspace(<SmsSignupStep />);
    expect(screen.queryByTestId('sms-signup-step')).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.includes('sms-consent'))).toBe(false);
  });

  it('is not shown while texts are not available, and is not kept for later', async () => {
    markSmsSignupOffer();
    stub({ 'GET /v1/sign/me/sms-consent': { ...CONSENT_NONE, available: false } });
    inWorkspace(<SmsSignupStep />);
    await waitFor(() => expect(window.localStorage.getItem(SMS_SIGNUP_OFFER_KEY)).toBeNull());
    expect(screen.queryByTestId('sms-signup-step')).not.toBeInTheDocument();
  });

  it('"Not now" skips it', async () => {
    markSmsSignupOffer();
    const calls = stub({ 'GET /v1/sign/me/sms-consent': CONSENT_NONE });
    inWorkspace(<SmsSignupStep />);
    expect(await screen.findByText(SMS_SIGNUP_STEP_TITLE)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('sms-signup-skip'));
    expect(screen.queryByTestId('sms-signup-step')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(SMS_SIGNUP_OFFER_KEY)).toBeNull();
    expect(writes(calls)).toHaveLength(0);
  });

  it('opens the same flow, saving consent with channel SIGNUP', async () => {
    markSmsSignupOffer();
    const calls = stub({
      'GET /v1/sign/me/sms-consent': CONSENT_VERIFIED,
      'PUT /v1/sign/me/sms-consent': CONSENT_ON,
    });
    inWorkspace(<SmsSignupStep />);
    fireEvent.click(await screen.findByTestId('sms-signup-start'));
    const box = (await screen.findByTestId('sms-consent-agree')) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(screen.getByTestId('sms-consent-save'));
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        {
          method: 'PUT',
          path: '/v1/sign/me/sms-consent',
          body: { consented: true, wording_version: '2026-11-28', channel: 'SIGNUP' },
        },
      ]),
    );
  });
});
