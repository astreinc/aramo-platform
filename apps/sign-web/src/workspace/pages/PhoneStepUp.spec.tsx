import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PhoneStepUpPanel } from './PhoneStepUp';

// SIGN-FREE-PARITY-1 S2 — the sender's own phone step-up panel (Review & send).

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const STATUS = { available: true, required: true, phone_masked: '+1••••••••67' };

describe('PhoneStepUpPanel', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('texts a code to the number on file, verifies it and offers Send now', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: init?.body !== undefined ? JSON.parse(String(init.body)) : null });
        if (url.endsWith('/v1/sign/personal/step-up/send')) return json({ sent: true, phone_masked: '+1••••••••67', expires_in_seconds: 600, resend_after_seconds: 60 });
        if (url.endsWith('/v1/sign/personal/step-up/verify')) return json({ verified: true });
        return json({});
      }),
    );
    const onVerified = vi.fn();
    render(<PhoneStepUpPanel status={STATUS} onVerified={onVerified} onClose={vi.fn()} />);
    expect(screen.getByText('We’ll text a code to +1••••••••67.', { exact: false })).toBeInTheDocument();
    // SMS-OPTIN-1 — the 10DLC opt-in disclosure sits with the button.
    expect(screen.getByTestId('step-up-disclosure').textContent).toBe('We’ll text one 6-digit code to this number. Msg & data rates may apply. Reply STOP to opt out.');
    fireEvent.click(screen.getByTestId('step-up-send'));
    await screen.findByText('We texted a code to +1••••••••67. It expires in 10 minutes.');
    expect(calls.find((c) => c.url.endsWith('/send'))?.body).toEqual({});
    fireEvent.change(screen.getByTestId('step-up-code'), { target: { value: '12 34 56' } });
    expect(screen.getByTestId('step-up-code')).toHaveValue('123456');
    fireEvent.click(screen.getByTestId('step-up-verify'));
    await screen.findByTestId('step-up-verified');
    expect(calls.find((c) => c.url.endsWith('/verify'))?.body).toEqual({ code: '123456' });
    fireEvent.click(screen.getByTestId('step-up-send-now'));
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it('asks for a number when none is on file, and shows a wrong code plainly', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: init?.body !== undefined ? JSON.parse(String(init.body)) : null });
        if (url.endsWith('/send')) return json({ sent: true, phone_masked: '+9••••••••10', expires_in_seconds: 600, resend_after_seconds: 60 });
        if (url.endsWith('/verify')) return json({ error: { code: 'VALIDATION_ERROR', message: 'x', details: { reason: 'code_invalid', attempts_remaining: 4 } } }, 400);
        return json({});
      }),
    );
    render(<PhoneStepUpPanel status={{ ...STATUS, phone_masked: null }} onVerified={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId('step-up-send')).toBeDisabled();
    fireEvent.change(screen.getByTestId('step-up-phone'), { target: { value: '+919876543210' } });
    fireEvent.click(screen.getByTestId('step-up-send'));
    await screen.findByTestId('step-up-code');
    expect(calls.find((c) => c.url.endsWith('/send'))?.body).toEqual({ phone: '+919876543210' });
    fireEvent.change(screen.getByTestId('step-up-code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByTestId('step-up-verify'));
    await waitFor(() => expect(screen.getByText('That code isn’t right. Check the code and try again.')).toBeInTheDocument());
  });
});
