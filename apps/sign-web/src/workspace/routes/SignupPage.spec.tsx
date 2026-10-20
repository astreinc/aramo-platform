import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';

import { tokenFromHash } from './SignupPage';

// Aramo Sign launch (Journey B) — the public signup pages: reachable without a
// session, never claim more than the backend said, read the token from the
// fragment and drop it from the address bar, recover from a taken name.

vi.mock('../pdf', () => ({ loadPdf: vi.fn() }));

const TOKEN = 'a'.repeat(43);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

describe('signup pages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('/signup needs no session and posts only the form fields', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/v1/signup/sign/start') ? json({ accepted: true }, 202) : String(input).endsWith('/v1/signup/sign/terms') ? json({ terms: null }) : json({}, 401),
    );
    vi.stubGlobal('fetch', fetch);
    at('/signup');
    fireEvent.change(await screen.findByLabelText('Work email'), { target: { value: 'pat@astre.test' } });
    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Astre Consulting' } });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Pat Lee' } });
    fireEvent.click(screen.getByTestId('signup-submit'));
    expect(await screen.findByTestId('signup-sent')).toHaveTextContent('If pat@astre.test can be used');
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith('/start'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ email: 'pat@astre.test', organization_name: 'Astre Consulting', display_name: 'Pat Lee' });
    // The session probe answers 401 here: the page works without a session.
  });

  it('a form error from the backend is shown in place', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/terms') ? json({ terms: null }) : json({ error: { code: 'VALIDATION_ERROR', message: 'Use your work email address', details: { reason: 'business_email_required' } } }, 400))));
    at('/signup');
    fireEvent.change(await screen.findByLabelText('Work email'), { target: { value: 'pat@gmail.com' } });
    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Pat' } });
    fireEvent.click(screen.getByTestId('signup-submit'));
    expect(await screen.findByText('Use your work email address')).toBeInTheDocument();
  });

  it('verify: reads the fragment token, clears it, confirms, and recovers from a taken name', async () => {
    window.history.replaceState(null, '', `/signup/verify#token=${TOKEN}`);
    let completes = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/preview')) return json({ email: 'pat@astre.test', organization_name: 'Astre', status: 'READY' });
      if (url.endsWith('/complete')) {
        completes += 1;
        const body = JSON.parse(String(init?.body));
        expect(body.token).toBe(TOKEN);
        if (completes === 1) return json({ error: { code: 'TENANT_ALREADY_EXISTS', message: 'Choose another name.', details: { reason: 'organization_name_taken' } } }, 409);
        expect(body.organization_name).toBe('Astre Consulting');
        return json({ status: 'PROVISIONED', email: 'pat@astre.test', organization_name: 'Astre Consulting', sign_in_url: 'https://esign.example.test/login', sign_in: { microsoft: 'https://sign.example.test/auth/sign/login?idp=microsoft&return_to=%2F', google: 'https://sign.example.test/auth/sign/login?idp=google&return_to=%2F' } });
      }
      return json({}, 401);
    });
    vi.stubGlobal('fetch', fetch);
    at('/signup/verify');
    expect(await screen.findByTestId('signup-confirm')).toHaveTextContent('pat@astre.test');
    expect(window.location.hash).toBe('');
    fireEvent.click(screen.getByTestId('signup-create'));
    expect(await screen.findByText('Choose another name.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Astre Consulting' } });
    fireEvent.click(screen.getByTestId('signup-create'));
    expect(await screen.findByTestId('signup-done')).toHaveTextContent('Astre Consulting');
    expect(screen.getByTestId('signup-signin-microsoft')).toHaveAttribute('href', 'https://sign.example.test/auth/sign/login?idp=microsoft&return_to=%2F');
    expect(screen.getByTestId('signup-signin-google')).toHaveAttribute('href', 'https://sign.example.test/auth/sign/login?idp=google&return_to=%2F');
    // Sign-Signup-Federated-Owner R3 — no password is issued or mentioned.
    expect(screen.getByTestId('signup-done').textContent ?? '').not.toMatch(/password/i);
  });

  it('verify without a usable link, or with a rejected one, offers to start again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404)));
    at('/signup/verify');
    expect(await screen.findByTestId('signup-invalid')).toBeInTheDocument();
    window.history.replaceState(null, '', `/signup/verify#token=${TOKEN}`);
    at('/signup/verify');
    await waitFor(() => expect(screen.getAllByTestId('signup-invalid').length).toBeGreaterThan(0));
  });

  it('approved terms must be ticked and are sent; a dark signup says so up front', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/terms') ? json({ terms: { version: '1.0.0', url: 'https://aramo.ai/legal/terms' } }) : String(input).endsWith('/start') ? json({ accepted: true }, 202) : json({}, 401),
    );
    vi.stubGlobal('fetch', fetch);
    const { unmount } = at('/signup');
    fireEvent.change(await screen.findByLabelText('Work email'), { target: { value: 'pat@astre.test' } });
    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Astre' } });
    await waitFor(() => expect(screen.getByTestId('signup-submit')).toBeDisabled());
    fireEvent.click(await screen.findByTestId('signup-terms'));
    fireEvent.click(screen.getByTestId('signup-submit'));
    await screen.findByTestId('signup-sent');
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith('/start'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body)).accept_terms).toBe(true);
    unmount();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/terms') ? json({ error: { code: 'NOT_FOUND' } }, 404) : json({}, 401))));
    at('/signup');
    expect(await screen.findByTestId('signup-unavailable')).toBeInTheDocument();
  });

  it('tokenFromHash accepts only a plausible token', () => {
    expect(tokenFromHash(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash('#token=short')).toBeNull();
    expect(tokenFromHash('')).toBeNull();
  });
});
