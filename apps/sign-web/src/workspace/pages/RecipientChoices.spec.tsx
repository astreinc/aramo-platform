import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import type { SenderContext } from '../api';

import { readinessOf } from './readiness';

// Consolidated Directive v1.0 B2 — the sender's per-recipient choices on the Recipients step:
// witness, delegation, access code, identity check, text delivery and the SMS code. Each
// control shows only while GET /v1/sign/sender/context reports it available.

vi.mock('../pdf', () => ({ loadPdf: vi.fn() }));

const SESSION = { sub: 'u1', consumer_type: 'sign', tenant_id: 't1', scopes: ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send'], iat: 0, exp: 9_999_999_999 };

const ALL_ON = {
  witness_signing: true,
  delegate_signing: true,
  access_code: true,
  sms_delivery: true,
  whatsapp_delivery: true,
  sms_otp: true,
  id_verification: true,
  kba: true,
};

function ctx(features: SenderContext['features'] = {}): SenderContext {
  return {
    user: { id: 'u1', email: 'priya@northwind.test', display_name: 'Priya Nair' },
    tenant: { id: 't1', name: 'Northwind Staffing', kind: 'BUSINESS' },
    workspace: 'sign',
    permissions: { read: true, create: true, send: true },
    features,
    can_send: true,
    personal_sending_enabled: false,
    organization_url: null,
    app_home_url: null,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function draft(recipients: Record<string, unknown>[], over: Record<string, unknown> = {}) {
  return {
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
    recipients,
    fields: [],
    ...over,
  };
}

const R1 = { id: 'r1', name: 'Alex Lee', email: 'alex@x.test', status: 'PENDING', signing_order: 1, recipient_kind: 'SIGNER', copy_delivery: null, assigned_to_me: false };
const R2 = { id: 'r2', name: 'Casey', email: 'casey@x.test', status: 'PENDING', signing_order: 2, recipient_kind: 'SIGNER', copy_delivery: null, assigned_to_me: false };

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function stub(context: SenderContext, env: ReturnType<typeof draft>, messaging: unknown[] = []) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/auth/sign/session')) return json(SESSION);
      if (url.endsWith('/v1/sign/sender/context')) return json(context);
      if (url.includes('/v1/sign/sender/envelopes/e9')) {
        if (method !== 'GET') calls.push({ method, url: url.slice(url.indexOf('/v1/')), body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url.endsWith('/messaging') && method === 'GET') return json({ envelope_id: 'e9', recipients: messaging, deliveries: [] });
        if (url.endsWith('/messaging')) return json({ signer_id: 'r1', delivery_channel: 'SMS', sms_otp_required: true, phone_e164: '+14155550123' });
        return json(env);
      }
      return json({ items: [] });
    }),
  );
  return calls;
}

function renderStep2() {
  return render(
    <MemoryRouter initialEntries={['/sign/envelopes/e9/edit?step=2']}>
      <App />
    </MemoryRouter>,
  );
}

describe('Recipients step — B2 choices', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('shows none of the choices while the context reports them unavailable', async () => {
    stub(ctx(), draft([R1, R2]));
    renderStep2();
    await screen.findAllByTestId('recipient-role');
    expect(screen.queryByTestId('allow-delegation')).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Witnesses a signer' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('add-access-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('delivery-channel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sms-code')).not.toBeInTheDocument();
    const checks = screen.getAllByTestId('identity-check');
    expect(checks[0]).toBeDisabled();
    expect(screen.queryByRole('option', { name: /photo ID check/i })).not.toBeInTheDocument();
  });

  it('saves delegation, a witness, an access code, an identity check and text delivery', async () => {
    const calls = stub(ctx(ALL_ON), draft([R1, R2]));
    renderStep2();
    const roles = await screen.findAllByTestId('recipient-role');
    fireEvent.click(screen.getByTestId('allow-delegation'));
    // Casey witnesses Alex (the only signer is picked by default).
    fireEvent.change(roles[1]!, { target: { value: 'WITNESS' } });
    expect((await screen.findByTestId('witness-for')) as HTMLSelectElement).toHaveValue('r1');
    // Alex: an access code, a photo ID check, SMS delivery and the SMS code.
    fireEvent.click(screen.getAllByTestId('add-access-code')[0]!);
    fireEvent.change(screen.getByTestId('access-code-input'), { target: { value: 'Blue-42' } });
    fireEvent.change(screen.getAllByTestId('identity-check')[0]!, { target: { value: 'ID_VERIFICATION' } });
    fireEvent.change(screen.getByTestId('delivery-channel'), { target: { value: 'SMS' } });
    fireEvent.click(screen.getByTestId('sms-code'));
    // A number that is not E.164 is refused before anything is saved.
    fireEvent.change(screen.getByTestId('recipient-phone'), { target: { value: '415 555 0123' } });
    expect(screen.getByText('Enter the number with + and the country code, no spaces.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('recipients-continue'));
    expect(await screen.findByText(/Enter the mobile number for Alex Lee in international format/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);

    fireEvent.change(screen.getByTestId('recipient-phone'), { target: { value: '+14155550123' } });
    fireEvent.click(screen.getByTestId('recipients-continue'));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[0]).toEqual({ method: 'PATCH', url: '/v1/sign/sender/envelopes/e9', body: { allow_delegation: true } });
    expect(calls[1]).toEqual({
      method: 'PUT',
      url: '/v1/sign/sender/envelopes/e9/recipients',
      body: {
        recipients: [
          { id: 'r1', name: 'Alex Lee', email: 'alex@x.test', recipient_kind: 'SIGNER', copy_delivery: null, access_code: 'Blue-42', identity_verification_method: 'ID_VERIFICATION' },
          { id: 'r2', name: 'Casey', email: 'casey@x.test', recipient_kind: 'WITNESS', copy_delivery: null, witness_for_index: 0 },
        ],
      },
    });
    expect(calls[2]).toEqual({
      method: 'PUT',
      url: '/v1/sign/sender/envelopes/e9/recipients/r1/messaging',
      body: { delivery_channel: 'SMS', sms_otp_required: true, phone_e164: '+14155550123' },
    });
  });

  it('an access code already set can be removed (never shown); an invalid new code is refused', async () => {
    const calls = stub(ctx({ access_code: true }), draft([{ ...R1, access_code_set: true }, R2]));
    renderStep2();
    expect(await screen.findByText('Access code set')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the access code' }));
    expect(screen.getByText('The access code will be removed when you continue.')).toBeInTheDocument();
    // Casey gets a code that is too short.
    fireEvent.click(screen.getByTestId('add-access-code'));
    fireEvent.change(screen.getByTestId('access-code-input'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('recipients-continue'));
    expect(await screen.findByText(/The access code for Casey must be 4 to 32 characters/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    fireEvent.change(screen.getByTestId('access-code-input'), { target: { value: 'abcd' } });
    fireEvent.click(screen.getByTestId('recipients-continue'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0]!.body as { recipients: unknown[] }).recipients).toEqual([
      { id: 'r1', name: 'Alex Lee', email: 'alex@x.test', recipient_kind: 'SIGNER', copy_delivery: null, access_code: null },
      { id: 'r2', name: 'Casey', email: 'casey@x.test', recipient_kind: 'SIGNER', copy_delivery: null, access_code: 'abcd' },
    ]);
  });

  it('reads saved text delivery and clears it when the sender goes back to email only', async () => {
    const calls = stub(ctx({ sms_delivery: true }), draft([R1]), [{ signer_id: 'r1', delivery_channel: 'SMS', sms_otp_required: false, phone_e164: '+14155550123' }]);
    renderStep2();
    const channel = (await screen.findByTestId('delivery-channel')) as HTMLSelectElement;
    await waitFor(() => expect(channel).toHaveValue('SMS'));
    expect(screen.getByTestId('recipient-phone')).toHaveValue('+14155550123');
    // The SMS code option is not available here.
    expect(screen.queryByTestId('sms-code')).not.toBeInTheDocument();
    fireEvent.change(channel, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('recipients-continue'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ method: 'PUT', url: '/v1/sign/sender/envelopes/e9/recipients/r1/messaging', body: { delivery_channel: null, sms_otp_required: false } });
  });
});

describe('readiness — witnesses (Feature-Parity §1.17)', () => {
  const base = { documents: [{ id: 'd1' }], fields: [{ signer_id: 'r1', field_type: 'SIGNATURE' }, { signer_id: 'w1', field_type: 'SIGNATURE' }] };
  it('a witness must name a signer and, signing in order, come after them', () => {
    const w = { id: 'w1', name: 'Wes', recipient_kind: 'WITNESS', signing_order: 1, witness_for_signer_id: 'r1' };
    const r = { id: 'r1', name: 'Alex', recipient_kind: 'SIGNER', signing_order: 2 };
    const seq = readinessOf({ ...base, routing_mode: 'SEQUENTIAL', recipients: [w, r] } as never);
    expect(seq.ok).toBe(false);
    expect(seq.items.map((i) => i.t)).toContain('Wes witnesses Alex and must sign after them');
    expect(readinessOf({ ...base, routing_mode: 'PARALLEL', recipients: [w, r] } as never).ok).toBe(true);
    const orphan = readinessOf({ ...base, routing_mode: 'PARALLEL', recipients: [{ ...w, witness_for_signer_id: null }, r] } as never);
    expect(orphan.items.map((i) => i.t)).toContain('Wes needs a signer to witness');
  });
});
