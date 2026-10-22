import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';

import { tokenFromHash } from './SignupPage';

// Aramo Sign launch (Journey B) — the public signup pages: reachable without a
// session, never claim more than the backend said, read the token from the
// fragment and drop it from the address bar, collect the A1 details in the
// activation steps and send them as ONE `complete`, recover from a taken name.

vi.mock('../pdf', () => ({ loadPdf: vi.fn() }));

const TOKEN = 'a'.repeat(43);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

const PREVIEW = { email: 'pat@astre.test', organization_name: 'Astre', display_name: 'Pat Lee', status: 'READY' };
const DONE = {
  status: 'PROVISIONED',
  email: 'pat@astre.test',
  organization_name: 'Astre Consulting',
  sign_in_url: 'https://esign.example.test/login',
  sign_in: { microsoft: 'https://sign.example.test/auth/sign/login?idp=microsoft&return_to=%2F', google: 'https://sign.example.test/auth/sign/login?idp=google&return_to=%2F' },
};
const SUGGESTIONS = [
  { label: '100 Main St, Dallas, TX 75001', address_line1: '100 Main St', address_line2: null, city: 'Dallas', state_province: 'TX', postal_code: '75001' },
  { label: '200 Market St Suite 5, San Francisco, CA 94105', address_line1: '200 Market St', address_line2: 'Suite 5', city: 'San Francisco', state_province: 'CA', postal_code: '94105' },
];

/** /signup against a fetch mock: terms, personal terms and start. */
function startApi({ terms = null, personal = 404, start = () => json({ accepted: true }, 202) }: { terms?: unknown; personal?: number; start?: () => Response } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/signup/sign/personal/terms')) return json(personal === 404 ? { error: { code: 'NOT_FOUND' } } : { documents: null }, personal);
    if (url.endsWith('/v1/signup/sign/terms')) return json({ terms });
    if (url.endsWith('/v1/signup/sign/start')) return start();
    return json({}, 401);
  });
}

/** Opens /signup/verify with a valid fragment token against the given fetch mock. */
function verifyWith<F extends ReturnType<typeof vi.fn>>(fetch: F): F & { view: ReturnType<typeof at> } {
  window.history.replaceState(null, '', `/signup/verify#token=${TOKEN}`);
  vi.stubGlobal('fetch', fetch);
  return Object.assign(fetch, { view: at('/signup/verify') });
}

const verifyApi = (complete: (body: Record<string, unknown>) => Response = () => json(DONE), suggest?: () => Response | Promise<Response>) =>
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/preview')) return json(PREVIEW);
    if (url.endsWith('/address/suggest') && suggest !== undefined) return suggest();
    if (url.endsWith('/complete')) return complete(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return json({}, 401);
  });

/** The address-suggestion options (the State select has its own options). */
const suggestionList = () => screen.getByRole('listbox', { name: 'Address suggestions', hidden: true });
const suggestions = () => within(suggestionList()).queryAllByRole('option');
const findSuggestions = () =>
  waitFor(() => {
    const o = suggestions();
    expect(o.length).toBeGreaterThan(0);
    return o;
  });

const next = () => fireEvent.click(screen.getByTestId('signup-next'));
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

async function fillOrganization() {
  await screen.findByTestId('signup-step-organization');
  change('Legal name', 'Astre Consulting Services Inc');
  next();
}
async function fillAddress() {
  await screen.findByTestId('signup-step-address');
  change('Street address', '100 Main St');
  change('City', 'Dallas');
  change('State', 'TX');
  change('ZIP code', '75001');
  next();
}
async function fillBilling(extra: () => void = () => undefined) {
  await screen.findByTestId('signup-step-billing');
  extra();
  next();
}
async function fillYou({ attest = true }: { attest?: boolean } = {}) {
  await screen.findByTestId('signup-step-you');
  change('Your title', 'CEO');
  if (attest) fireEvent.click(screen.getByTestId('signup-authority'));
  next();
}
async function toReview() {
  await fillOrganization();
  await fillAddress();
  await fillBilling();
  await fillYou();
  return screen.findByTestId('signup-step-review');
}
const activate = () => fireEvent.click(screen.getByTestId('signup-create'));
const completeBody = (fetch: ReturnType<typeof vi.fn>, n = 0) => {
  const calls = fetch.mock.calls.filter(([u]) => String(u).endsWith('/complete'));
  return JSON.parse(String((calls[n]![1] as RequestInit).body)) as Record<string, unknown>;
};

describe('/signup', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('needs no session, sits in the sign-in frame, and posts only the form fields', async () => {
    const fetch = startApi();
    vi.stubGlobal('fetch', fetch);
    at('/signup');
    expect(await screen.findByRole('region', { name: 'Create your Aramo Sign account' })).toBeInTheDocument();
    expect(screen.getByText('No passwords. You sign in with your Google or Microsoft account.')).toBeInTheDocument();
    change('Work email', 'pat@astre.test');
    change('Organization name', 'Astre Consulting');
    change('Your name', 'Pat Lee');
    fireEvent.click(screen.getByTestId('signup-submit'));
    expect(await screen.findByTestId('signup-sent')).toHaveTextContent('We sent an email to pat@astre.test.');
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith('/start'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ email: 'pat@astre.test', organization_name: 'Astre Consulting', display_name: 'Pat Lee' });
    // The email-first flow: no provider sign-in is offered before the organization exists.
    expect(screen.queryByText(/Continue with (Microsoft|Google)/)).toBeNull();
  });

  it('check your email: resend waits 60 seconds, re-posts start, then waits again; "Use a different email" returns to the form', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = startApi();
    vi.stubGlobal('fetch', fetch);
    at('/signup');
    change('Work email', 'pat@astre.test');
    change('Organization name', 'Astre');
    fireEvent.click(screen.getByTestId('signup-submit'));
    await screen.findByTestId('signup-sent');
    const resend = screen.getByTestId('code-resend');
    expect(resend).toBeDisabled();
    expect(resend).toHaveTextContent('Resend in 1:00');
    for (let i = 0; i < 61; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(resend).not.toBeDisabled();
    expect(resend).toHaveTextContent('Resend');
    fireEvent.click(resend);
    await waitFor(() => expect(fetch.mock.calls.filter(([u]) => String(u).endsWith('/start'))).toHaveLength(2));
    expect(await screen.findByRole('status')).toHaveTextContent('We asked for another email.');
    await waitFor(() => expect(screen.getByTestId('code-resend')).toBeDisabled());
    fireEvent.click(screen.getByTestId('signup-restart'));
    expect(await screen.findByTestId('signup-form')).toBeInTheDocument();
  });

  it('validates the form before sending anything', async () => {
    const fetch = startApi();
    vi.stubGlobal('fetch', fetch);
    at('/signup');
    fireEvent.click(await screen.findByTestId('signup-submit'));
    expect(await screen.findByText('Enter your work email address.')).toBeInTheDocument();
    expect(screen.getByLabelText('Work email')).toHaveAttribute('aria-invalid', 'true');
    expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/start'))).toBe(false);
  });

  it('a business_email_required refusal shows the rejection box in place (one backend reason for personal and disposable)', async () => {
    vi.stubGlobal('fetch', startApi({ start: () => json({ error: { code: 'VALIDATION_ERROR', message: 'Use your work email address', details: { reason: 'business_email_required' } } }, 400) }));
    at('/signup');
    change('Work email', 'pat@gmail.com');
    change('Organization name', 'Pat');
    fireEvent.click(screen.getByTestId('signup-submit'));
    const box = await screen.findByTestId('signup-reject');
    expect(box).toHaveAttribute('role', 'alert');
    expect(box).toHaveTextContent('That’s not a work email');
    expect(screen.getByLabelText('Work email')).toHaveAttribute('aria-describedby', 'su-reject');
    // No Personal mode → no switch link.
    expect(screen.queryByTestId('signup-switch-personal')).toBeNull();
    // Editing the email clears the box.
    change('Work email', 'pat@astre.test');
    expect(screen.queryByTestId('signup-reject')).toBeNull();
  });

  it('with Personal open, the rejection offers the free personal account and the link switches the type in place', async () => {
    vi.stubGlobal('fetch', startApi({ personal: 200, start: () => json({ error: { code: 'VALIDATION_ERROR', message: 'x', details: { reason: 'business_email_required' } } }, 400) }));
    at('/signup');
    await screen.findByTestId('signup-type-personal');
    change('Work email', 'pat@gmail.com');
    change('Organization name', 'Pat');
    fireEvent.click(screen.getByTestId('signup-submit'));
    fireEvent.click(await screen.findByTestId('signup-switch-personal'));
    expect(screen.getByTestId('signup-type-personal')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('signup-personal-link')).toHaveAttribute('href', '/signup/personal');
  });

  it('any other refusal is the neutral one: no reason, nothing about an existing account', async () => {
    vi.stubGlobal('fetch', startApi({ start: () => json({ error: { code: 'INTERNAL_ERROR', message: 'tenant exists for domain' } }, 500) }));
    at('/signup');
    change('Work email', 'pat@astre.test');
    change('Organization name', 'Astre');
    fireEvent.click(screen.getByTestId('signup-submit'));
    const card = await screen.findByTestId('signup-refused');
    expect(card).toHaveTextContent('We couldn’t create your account right now');
    expect(card.textContent ?? '').not.toMatch(/exists|already|domain/i);
    expect(screen.getByRole('link', { name: 'Contact support' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign up' }));
    expect(await screen.findByTestId('signup-form')).toBeInTheDocument();
  });

  it('approved terms are accepted at the start (never at review), must be ticked and are sent; a dark signup says so up front', async () => {
    const fetch = startApi({ terms: { version: '1.0.0', url: 'https://aramo.ai/legal/terms' } });
    vi.stubGlobal('fetch', fetch);
    const { unmount } = at('/signup');
    change('Work email', 'pat@astre.test');
    change('Organization name', 'Astre');
    await waitFor(() => expect(screen.getByTestId('signup-submit')).toBeDisabled());
    expect(screen.getByTestId('signup-terms').closest('label')).toHaveTextContent('I agree to the Aramo Sign Terms of Service (version 1.0.0)');
    fireEvent.click(await screen.findByTestId('signup-terms'));
    fireEvent.click(screen.getByTestId('signup-submit'));
    await screen.findByTestId('signup-sent');
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith('/start'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body)).accept_terms).toBe(true);
    unmount();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/terms') ? json({ error: { code: 'NOT_FOUND' } }, 404) : json({}, 401))));
    at('/signup');
    const dark = await screen.findByTestId('signup-unavailable');
    expect(dark).toHaveTextContent('Signing up online isn’t available yet');
    expect(within(dark).getByRole('link', { name: 'Contact sales' })).toBeInTheDocument();
  });

  // Aramo Sign Personal (Free) — the Personal type appears only while the Personal
  // mode is not off (its public terms route answers 404 when off).
  it('the account-type radiogroup offers Personal only when the Personal terms route does not 404', async () => {
    vi.stubGlobal('fetch', startApi({ personal: 200 }));
    const { unmount } = at('/signup');
    const group = await screen.findByRole('radiogroup', { name: 'Account type' });
    await waitFor(() => expect(within(group).getAllByRole('radio')).toHaveLength(2));
    const business = screen.getByTestId('signup-type-business');
    expect(business).toHaveAttribute('aria-checked', 'true');
    expect(business).toHaveTextContent('Paid plans');
    expect(screen.getByTestId('signup-type-personal')).toHaveTextContent('Free');
    fireEvent.keyDown(business, { key: 'ArrowDown' });
    expect(screen.getByTestId('signup-type-personal')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('signup-type-personal')).toHaveFocus();
    expect(screen.getByTestId('signup-personal-link')).toHaveAttribute('href', '/signup/personal');
    expect(screen.queryByLabelText('Work email')).toBeNull();
    unmount();
    const off = startApi();
    vi.stubGlobal('fetch', off);
    at('/signup');
    await screen.findByTestId('signup-form');
    await waitFor(() => expect(off.mock.calls.some(([u]) => String(u).endsWith('/personal/terms'))).toBe(true));
    // Let the 404 settle, then Personal is still absent.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect(screen.queryByTestId('signup-type-personal')).toBeNull();
  });
});

describe('/signup/verify — activation steps', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('reads the fragment token, clears it, and walks Organization → Address → Billing → You → Review → one complete → done', async () => {
    const fetch = verifyWith(verifyApi());
    await screen.findByTestId('signup-confirm');
    expect(window.location.hash).toBe('');
    // No session exists yet: the header never says "Signed in as".
    expect(screen.getByTestId('signup-confirm').textContent ?? '').not.toMatch(/Signed in as/);
    const nav = screen.getByRole('navigation', { name: 'Setup steps' });
    expect(within(nav).getByTestId('step-organization')).toHaveAttribute('aria-current', 'step');
    expect(within(nav).getByTestId('step-address')).toBeDisabled();
    expect(screen.getByTestId('setup-progress')).toHaveTextContent('Step 1 of 5 · Organization');
    await toReview();
    expect(screen.getByTestId('setup-progress')).toHaveTextContent('Step 5 of 5 · Review');
    const review = screen.getByTestId('signup-review');
    expect(review).toHaveTextContent('Astre Consulting Services Inc');
    expect(review).toHaveTextContent('100 Main St');
    expect(review).toHaveTextContent('Dallas, TX 75001');
    expect(review).toHaveTextContent('pat@astre.test');
    expect(review).toHaveTextContent('Pat Lee, CEO');
    // Terms were accepted at the start (A1 Refinement C): no second terms checkbox.
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/complete'))).toBe(false);
    activate();
    const done = await screen.findByTestId('signup-done');
    expect(done).toHaveTextContent('Astre Consulting is active');
    expect(done).toHaveTextContent('Use the work account for pat@astre.test. The provider you sign in with first becomes your organization’s sign-in provider.');
    expect(done).toHaveTextContent('Sign in to choose a plan');
    expect(screen.queryByRole('button', { name: /choose a plan/i })).toBeNull();
    expect(screen.getByTestId('signup-signin-microsoft')).toHaveAttribute('href', DONE.sign_in.microsoft);
    expect(screen.getByTestId('signup-signin-google')).toHaveAttribute('href', DONE.sign_in.google);
    // Sign-Signup-Federated-Owner R3 — no password is issued or mentioned.
    expect(done.textContent ?? '').not.toMatch(/password/i);
    // Every step shows done; none is clickable.
    for (const k of ['organization', 'address', 'billing', 'you', 'review']) expect(screen.getByTestId(`step-${k}`)).toBeDisabled();
    expect(fetch.mock.calls.filter(([u]) => String(u).endsWith('/complete'))).toHaveLength(1);
    expect(completeBody(fetch)).toEqual({
      token: TOKEN,
      organization: {
        legal_name: 'Astre Consulting Services Inc',
        address_line1: '100 Main St',
        city: 'Dallas',
        state_province: 'TX',
        postal_code: '75001',
        country_code: 'US',
        primary_contact_email: 'pat@astre.test',
        primary_contact_name: 'Pat Lee',
        signer_title: 'CEO',
        authority_attested: true,
      },
    });
  });

  it('A1: the Organization step states US-only before any data entry; defaults come from the preview', async () => {
    verifyWith(verifyApi());
    await screen.findByTestId('signup-step-organization');
    const notice = screen.getByTestId('signup-us-notice');
    expect(notice).toHaveTextContent('United States');
    const help = screen.getByText(/Aramo Sign Business is available to US organizations only/);
    expect(help).toHaveTextContent('Aramo Sign Business is available to US organizations only. Outside the US? Contact sales.');
    expect(screen.getByRole('link', { name: 'Contact sales' })).toHaveAttribute('href', 'https://aramo.ai/company/contact.html?route=Aramo%20Sign');
    expect(notice.compareDocumentPosition(screen.getByLabelText('Legal name')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText('Organization name')).toHaveValue('Astre');
    await fillOrganization();
    await screen.findByTestId('signup-step-address');
    // 50 states + DC only — no territories or military codes.
    const codes = Array.from((screen.getByLabelText('State') as HTMLSelectElement).options)
      .map((o) => o.value)
      .filter(Boolean);
    expect(codes).toHaveLength(51);
    expect(codes).toContain('DC');
    for (const t of ['PR', 'GU', 'VI', 'AS', 'MP', 'AA', 'AE', 'AP']) expect(codes).not.toContain(t);
    await fillAddress();
    await screen.findByTestId('signup-step-billing');
    expect(screen.getByLabelText('Billing contact email')).toHaveValue('pat@astre.test');
    next();
    await screen.findByTestId('signup-step-you');
    expect(screen.getByLabelText('Your name')).toHaveValue('Pat Lee');
    // The attestation is never preselected and names the organization.
    expect(screen.getByTestId('signup-authority')).not.toBeChecked();
    expect(screen.getByTestId('signup-authority').closest('label')).toHaveTextContent('I am authorized to act for Astre and to accept the Aramo terms on its behalf.');
  });

  it('A1: each step validates on Continue with inline messages; an edit clears that field’s error', async () => {
    const fetch = verifyWith(verifyApi());
    await screen.findByTestId('signup-step-organization');
    change('Organization name', '');
    next();
    expect(await screen.findByText('Enter the legal name (2–200 characters).')).toBeInTheDocument();
    expect(screen.getByText('Enter an organization name (2–100 characters).')).toBeInTheDocument();
    const legal = screen.getByLabelText('Legal name');
    expect(legal).toHaveAttribute('aria-invalid', 'true');
    expect(legal.getAttribute('aria-describedby')).toContain('sv-legal-error');
    expect(screen.getByText('Enter the legal name (2–200 characters).')).toHaveAttribute('role', 'alert');
    change('Legal name', 'Astre Consulting Services Inc');
    expect(screen.queryByText('Enter the legal name (2–200 characters).')).toBeNull();
    change('Organization name', 'Astre');
    next();
    await screen.findByTestId('signup-step-address');
    next();
    expect(await screen.findByText('Enter the street address.')).toBeInTheDocument();
    expect(screen.getByText('Choose a state.')).toBeInTheDocument();
    change('Street address', '100 Main St');
    change('City', 'Dallas');
    change('State', 'TX');
    change('ZIP code', '7501');
    next();
    expect(await screen.findByText('Use a 5-digit ZIP code, like 22181.')).toBeInTheDocument();
    change('ZIP code', '75001-1234');
    next();
    await fillBilling(() => {
      change('EIN (optional)', '12-345');
    });
    expect(await screen.findByText('Enter the EIN as 12-3456789.')).toBeInTheDocument();
    change('EIN (optional)', '12-3456789');
    change('Phone (optional)', '(214) 555-0100');
    next();
    await screen.findByTestId('signup-step-you');
    change('Your title', 'CEO');
    next();
    expect(await screen.findByText('Confirm that you are authorized to act for this organization.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('signup-authority'));
    next();
    await screen.findByTestId('signup-step-review');
    activate();
    await screen.findByTestId('signup-done');
    expect(completeBody(fetch)['organization']).toMatchObject({ postal_code: '75001-1234', tax_id: '12-3456789', primary_contact_phone: '+12145550100' });
  });

  it('done steps can be revisited from the list and Back; future steps cannot be skipped; review Edit links open their step', async () => {
    verifyWith(verifyApi());
    await fillOrganization();
    await fillAddress();
    await screen.findByTestId('signup-step-billing');
    expect(screen.getByTestId('step-you')).toBeDisabled();
    expect(screen.getByTestId('step-review')).toBeDisabled();
    fireEvent.click(screen.getByTestId('step-organization'));
    expect(await screen.findByTestId('signup-step-organization')).toBeInTheDocument();
    expect(screen.getByLabelText('Legal name')).toHaveValue('Astre Consulting Services Inc');
    next();
    await screen.findByTestId('signup-step-address');
    fireEvent.click(screen.getByTestId('step-back'));
    await screen.findByTestId('signup-step-organization');
    expect(screen.queryByTestId('step-back')).toBeNull();
    next();
    await fillAddress();
    await fillBilling();
    await fillYou();
    await screen.findByTestId('signup-step-review');
    fireEvent.click(screen.getByTestId('review-edit-address'));
    expect(await screen.findByTestId('signup-step-address')).toBeInTheDocument();
    expect(screen.getByLabelText('City')).toHaveValue('Dallas');
  });

  it('a taken name returns to the Organization step with the message; the new name is sent', async () => {
    let n = 0;
    const fetch = verifyWith(
      verifyApi(() => {
        n += 1;
        return n === 1 ? json({ error: { code: 'TENANT_ALREADY_EXISTS', message: 'Choose another name.', details: { reason: 'organization_name_taken' } } }, 409) : json(DONE);
      }),
    );
    await toReview();
    activate();
    expect(await screen.findByText('Choose another name.')).toBeInTheDocument();
    expect(screen.getByTestId('signup-step-organization')).toBeInTheDocument();
    change('Organization name', 'Astre Consulting');
    next();
    await fillAddress();
    await fillBilling();
    await screen.findByTestId('signup-step-you');
    next();
    await screen.findByTestId('signup-step-review');
    activate();
    await screen.findByTestId('signup-done');
    expect(completeBody(fetch, 0)).not.toHaveProperty('organization_name');
    expect(completeBody(fetch, 1)['organization_name']).toBe('Astre Consulting');
  });

  it('A1: a server field error opens that field’s step; country-not-supported is shown on the Organization step', async () => {
    let n = 0;
    verifyWith(
      verifyApi(() => {
        n += 1;
        return n === 1
          ? json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a valid ZIP code for this address.', details: { reason: 'organization_details_invalid', field: 'postal_code' } } }, 400)
          : json({ error: { code: 'VALIDATION_ERROR', message: 'Aramo Sign is currently available to organizations registered in the United States.', details: { reason: 'organization_country_not_supported', field: 'country_code' } } }, 400);
      }),
    );
    await toReview();
    activate();
    const msg = await screen.findByText('Enter a valid ZIP code for this address.');
    expect(screen.getByTestId('signup-step-address')).toBeInTheDocument();
    expect(screen.getByLabelText('ZIP code')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('ZIP code').getAttribute('aria-describedby')).toContain(msg.id);
    next();
    await fillBilling();
    await screen.findByTestId('signup-step-you');
    next();
    await screen.findByTestId('signup-step-review');
    activate();
    await screen.findByTestId('signup-step-organization');
    expect(await screen.findByRole('alert')).toHaveTextContent('Aramo Sign is currently available to organizations registered in the United States.');
  });

  it('A1: address autocomplete suggests after 3 characters, shows attribution, and fills four fields on select', async () => {
    const fetch = verifyWith(verifyApi(undefined, () => json({ available: true, suggestions: SUGGESTIONS, attribution: { label: 'Powered by Geoapify', url: 'https://www.geoapify.com/' } })));
    await fillOrganization();
    await screen.findByTestId('signup-step-address');
    const line1 = screen.getByLabelText('Street address');
    expect(line1).toHaveAttribute('role', 'combobox');
    expect(line1).toHaveAttribute('aria-expanded', 'false');
    fireEvent.change(line1, { target: { value: '10' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/address/suggest'))).toBe(false);
    fireEvent.change(line1, { target: { value: '100 Ma' } });
    const options = await findSuggestions();
    expect(options).toHaveLength(2);
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith('/address/suggest'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ token: TOKEN, text: '100 Ma' });
    expect(line1).toHaveAttribute('aria-expanded', 'true');
    expect(line1).toHaveAttribute('aria-controls', suggestionList().id);
    expect(screen.getByRole('link', { name: 'Powered by Geoapify' })).toHaveAttribute('href', 'https://www.geoapify.com/');
    fireEvent.click(options[1]!);
    expect(line1).toHaveValue('200 Market St');
    expect(screen.getByLabelText(/Address line 2/)).toHaveValue('Suite 5');
    expect(screen.getByLabelText('City')).toHaveValue('San Francisco');
    expect(screen.getByLabelText('State')).toHaveValue('CA');
    expect(screen.getByLabelText('ZIP code')).toHaveValue('94105');
    expect(suggestions()).toHaveLength(0);
    // Filled fields stay editable.
    change('City', 'Oakland');
    expect(screen.getByLabelText('City')).toHaveValue('Oakland');
  });

  it('A1: keyboard navigation selects a suggestion; Escape closes the list', async () => {
    verifyWith(verifyApi(undefined, () => json({ available: true, suggestions: SUGGESTIONS, attribution: null })));
    await fillOrganization();
    await screen.findByTestId('signup-step-address');
    const line1 = screen.getByLabelText('Street address');
    fireEvent.change(line1, { target: { value: '100 Ma' } });
    await findSuggestions();
    expect(screen.queryByRole('link', { name: 'Powered by Geoapify' })).toBeNull();
    fireEvent.keyDown(line1, { key: 'Escape' });
    expect(line1).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(line1, { key: 'ArrowDown' });
    fireEvent.keyDown(line1, { key: 'ArrowDown' });
    fireEvent.keyDown(line1, { key: 'ArrowUp' });
    const active = suggestions()[0]!;
    expect(active).toHaveAttribute('aria-selected', 'true');
    expect(line1).toHaveAttribute('aria-activedescendant', active.id);
    fireEvent.keyDown(line1, { key: 'Enter' });
    expect(line1).toHaveValue('100 Main St');
    expect(screen.getByLabelText('City')).toHaveValue('Dallas');
    expect(screen.getByLabelText('State')).toHaveValue('TX');
    expect(screen.getByLabelText('ZIP code')).toHaveValue('75001');
  });

  it('A1: a failing or unavailable suggest falls back to manual entry without an error', async () => {
    for (const reply of [
      () => json({ error: { code: 'RATE_LIMITED', message: 'x' } }, 429),
      () => json({ available: false, suggestions: [], attribution: null }),
      () => Promise.reject(new TypeError('network')),
    ]) {
      const fetch = verifyApi(undefined, reply);
      const { unmount } = verifyWith(fetch).view;
      await fillOrganization();
      await screen.findByTestId('signup-step-address');
      change('Street address', '100 Main St');
      await new Promise((r) => setTimeout(r, 350));
      expect(suggestions()).toHaveLength(0);
      expect(screen.queryByRole('alert')).toBeNull();
      change('City', 'Dallas');
      change('State', 'TX');
      change('ZIP code', '75001');
      next();
      await fillBilling();
      await fillYou();
      await screen.findByTestId('signup-step-review');
      activate();
      await screen.findByTestId('signup-done');
      expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/complete'))).toBe(true);
      unmount();
    }
  });

  it('without a usable link, or with a rejected one: "This link can’t be used" with Start again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404)));
    at('/signup/verify');
    const card = await screen.findByTestId('signup-invalid');
    expect(card).toHaveTextContent('This link can’t be used');
    expect(within(card).getByRole('link', { name: 'Start again' })).toHaveAttribute('href', '/signup');
    window.history.replaceState(null, '', `/signup/verify#token=${TOKEN}`);
    at('/signup/verify');
    await waitFor(() => expect(screen.getAllByTestId('signup-invalid').length).toBeGreaterThan(0));
  });

  it('an already-created organization (link opened again) shows "already set up" with Go to sign in', async () => {
    verifyWith(vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/preview') ? json({ ...PREVIEW, status: 'PROVISIONED' }) : json({}, 401))));
    const card = await screen.findByTestId('signup-already');
    expect(card).toHaveTextContent('Your organization is already set up');
    expect(screen.getByTestId('signup-go-signin')).toHaveAttribute('href', '/login');
  });

  it('a domain already held by an organization (after verify) shows "already set up"', async () => {
    verifyWith(verifyApi(() => json({ error: { code: 'TENANT_DOMAIN_UNAVAILABLE', message: 'x', details: { reason: 'organization_domain_taken' } } }, 409)));
    await toReview();
    activate();
    expect(await screen.findByTestId('signup-already')).toHaveTextContent('ask your organization’s owner to invite you');
  });

  it('a server failure at activation keeps the review with a neutral message', async () => {
    verifyWith(verifyApi(() => json({ error: { code: 'INTERNAL_ERROR', message: 'saga step 3 failed' } }, 500)));
    await toReview();
    activate();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t create your organization right now.');
    expect(alert.textContent ?? '').not.toMatch(/saga/);
    expect(screen.getByTestId('signup-step-review')).toBeInTheDocument();
  });

  it('tokenFromHash accepts only a plausible token', () => {
    expect(tokenFromHash(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash('#token=short')).toBeNull();
    expect(tokenFromHash('')).toBeNull();
  });
});
