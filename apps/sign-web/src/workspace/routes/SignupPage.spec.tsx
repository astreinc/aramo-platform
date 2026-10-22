import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/** Opens /signup/verify with a valid fragment token against the given fetch mock. */
function verifyWith<F extends ReturnType<typeof vi.fn>>(fetch: F): F & { view: ReturnType<typeof at> } {
  window.history.replaceState(null, '', `/signup/verify#token=${TOKEN}`);
  vi.stubGlobal('fetch', fetch);
  return Object.assign(fetch, { view: at('/signup/verify') });
}

/** The address-suggestion options (the State select has its own options). */
const suggestionList = () => screen.getByRole('listbox', { name: 'Address suggestions', hidden: true });
const suggestions = () => within(suggestionList()).queryAllByRole('option');
const findSuggestions = () => waitFor(() => {
  const o = suggestions();
  expect(o.length).toBeGreaterThan(0);
  return o;
});

/** Fills the required A1 organization details (the defaults cover email and name). */
function fillRequired({ attest = true }: { attest?: boolean } = {}) {
  fireEvent.change(screen.getByLabelText('Legal name'), { target: { value: 'Astre Consulting Services Inc' } });
  fireEvent.change(screen.getByLabelText('Street address'), { target: { value: '100 Main St' } });
  fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Dallas' } });
  fireEvent.change(screen.getByLabelText('State'), { target: { value: 'TX' } });
  fireEvent.change(screen.getByLabelText('ZIP code'), { target: { value: '75001' } });
  fireEvent.change(screen.getByLabelText('Your title'), { target: { value: 'CEO' } });
  const box = screen.getByTestId('signup-authority') as HTMLInputElement;
  if (attest && !box.checked) fireEvent.click(box);
}

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

  it('verify: reads the fragment token, clears it, collects details, and recovers from a taken name', async () => {
    window.history.replaceState(null, '', `/signup/verify#token=${TOKEN}`);
    let completes = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/preview')) return json(PREVIEW);
      if (url.endsWith('/complete')) {
        completes += 1;
        const body = JSON.parse(String(init?.body));
        expect(body.token).toBe(TOKEN);
        expect(body.organization.country_code).toBe('US');
        if (completes === 1) return json({ error: { code: 'TENANT_ALREADY_EXISTS', message: 'Choose another name.', details: { reason: 'organization_name_taken' } } }, 409);
        expect(body.organization_name).toBe('Astre Consulting');
        return json(DONE);
      }
      return json({}, 401);
    });
    vi.stubGlobal('fetch', fetch);
    at('/signup/verify');
    expect(await screen.findByTestId('signup-confirm')).toHaveTextContent('pat@astre.test');
    expect(window.location.hash).toBe('');
    fillRequired();
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

  it('A1: the details form follows the preview and states US-only before any data entry', async () => {
    verifyWith(vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/preview') ? json(PREVIEW) : json({}, 401))));
    const form = await screen.findByTestId('signup-confirm');
    expect(form).toHaveTextContent('Organization details');
    const notice = screen.getByTestId('signup-us-notice');
    expect(notice).toHaveTextContent('Aramo Sign is currently available to organizations registered in the United States. Outside the US? Contact sales.');
    expect(screen.getByRole('link', { name: 'Contact sales' })).toHaveAttribute('href', 'https://aramo.ai/company/contact.html?route=Aramo%20Sign');
    // The notice comes before the first field.
    expect(notice.compareDocumentPosition(screen.getByLabelText('Legal name')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Defaults from the confirmed email and the step-1 name; country fixed.
    expect(screen.getByLabelText('Billing contact email')).toHaveValue('pat@astre.test');
    expect(screen.getByLabelText('Your full name')).toHaveValue('Pat Lee');
    expect(screen.getByLabelText('Country')).toHaveValue('United States');
    expect(screen.getByLabelText('Country')).toBeDisabled();
    // 50 states + DC only — no territories or military codes.
    const codes = Array.from((screen.getByLabelText('State') as HTMLSelectElement).options).map((o) => o.value).filter(Boolean);
    expect(codes).toHaveLength(51);
    expect(codes).toContain('DC');
    for (const t of ['PR', 'GU', 'VI', 'AS', 'MP', 'AA', 'AE', 'AP']) expect(codes).not.toContain(t);
    // The attestation is never preselected.
    expect(screen.getByTestId('signup-authority')).not.toBeChecked();
    expect(screen.getByTestId('signup-authority').closest('label')).toHaveTextContent('I am authorized to act for this organization and to accept the Aramo terms on its behalf.');
    fireEvent.change(screen.getByLabelText('Legal name'), { target: { value: 'Astre Consulting Services Inc' } });
    expect(screen.getByTestId('signup-authority').closest('label')).toHaveTextContent('I am authorized to act for Astre Consulting Services Inc and to accept');
  });

  it('A1: submit is blocked with inline messages until required fields and the attestation are valid; then the full body is sent', async () => {
    const fetch = verifyWith(
      vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/preview') ? json(PREVIEW) : String(input).endsWith('/complete') ? json(DONE) : json({}, 401))),
    );
    await screen.findByTestId('signup-confirm');
    fireEvent.click(screen.getByTestId('signup-create'));
    expect(await screen.findByText('Enter the legal name (2–200 characters).')).toBeInTheDocument();
    expect(screen.getByText('Enter the street address.')).toBeInTheDocument();
    expect(screen.getByText('Choose a state.')).toBeInTheDocument();
    expect(screen.getByText('Confirm that you are authorized to act for this organization.')).toBeInTheDocument();
    expect(screen.getByLabelText('Legal name')).toHaveAttribute('aria-invalid', 'true');
    fillRequired({ attest: false });
    fireEvent.change(screen.getByLabelText('ZIP code'), { target: { value: '7501' } });
    fireEvent.change(screen.getByLabelText('EIN (optional)'), { target: { value: '12-345' } });
    fireEvent.click(screen.getByTestId('signup-create'));
    expect(await screen.findByText('Enter a 5-digit ZIP code (or ZIP+4).')).toBeInTheDocument();
    expect(screen.getByText('Enter the EIN as 12-3456789.')).toBeInTheDocument();
    expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/complete'))).toBe(false);
    fireEvent.change(screen.getByLabelText('ZIP code'), { target: { value: '75001-1234' } });
    fireEvent.change(screen.getByLabelText('EIN (optional)'), { target: { value: '12-3456789' } });
    fireEvent.change(screen.getByLabelText('Phone (optional)'), { target: { value: '(214) 555-0100' } });
    fireEvent.click(screen.getByTestId('signup-authority'));
    fireEvent.click(screen.getByTestId('signup-create'));
    await screen.findByTestId('signup-done');
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith('/complete'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      token: TOKEN,
      organization: {
        legal_name: 'Astre Consulting Services Inc',
        address_line1: '100 Main St',
        city: 'Dallas',
        state_province: 'TX',
        postal_code: '75001-1234',
        country_code: 'US',
        primary_contact_email: 'pat@astre.test',
        primary_contact_name: 'Pat Lee',
        signer_title: 'CEO',
        primary_contact_phone: '+12145550100',
        tax_id: '12-3456789',
        authority_attested: true,
      },
    });
  });

  it('A1: a server field error is shown on that field; country-not-supported is shown in place', async () => {
    let n = 0;
    verifyWith(
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/preview')) return json(PREVIEW);
        if (url.endsWith('/complete')) {
          n += 1;
          return n === 1
            ? json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a valid ZIP code for this address.', details: { reason: 'organization_details_invalid', field: 'postal_code' } } }, 400)
            : json({ error: { code: 'VALIDATION_ERROR', message: 'Aramo Sign is currently available to organizations registered in the United States.', details: { reason: 'organization_country_not_supported', field: 'country_code' } } }, 400);
        }
        return json({}, 401);
      }),
    );
    await screen.findByTestId('signup-confirm');
    fillRequired();
    fireEvent.click(screen.getByTestId('signup-create'));
    const msg = await screen.findByText('Enter a valid ZIP code for this address.');
    expect(screen.getByLabelText('ZIP code')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('ZIP code')).toHaveAttribute('aria-describedby', msg.id);
    fireEvent.click(screen.getByTestId('signup-create'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Aramo Sign is currently available to organizations registered in the United States.');
  });

  it('A1: address autocomplete suggests after 3 characters, shows attribution, and fills the address on select', async () => {
    const fetch = verifyWith(
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/preview')) return json(PREVIEW);
        if (url.endsWith('/address/suggest')) return json({ available: true, suggestions: SUGGESTIONS, attribution: { label: 'Powered by Geoapify', url: 'https://www.geoapify.com/' } });
        return json({}, 401);
      }),
    );
    await screen.findByTestId('signup-confirm');
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
    expect(screen.getByLabelText('Address line 2 (optional)')).toHaveValue('Suite 5');
    expect(screen.getByLabelText('City')).toHaveValue('San Francisco');
    expect(screen.getByLabelText('State')).toHaveValue('CA');
    expect(screen.getByLabelText('ZIP code')).toHaveValue('94105');
    expect(suggestions()).toHaveLength(0);
    // Filled fields stay editable.
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Oakland' } });
    expect(screen.getByLabelText('City')).toHaveValue('Oakland');
  });

  it('A1: keyboard navigation selects a suggestion; Escape closes the list', async () => {
    verifyWith(
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/preview')) return json(PREVIEW);
        if (url.endsWith('/address/suggest')) return json({ available: true, suggestions: SUGGESTIONS, attribution: null });
        return json({}, 401);
      }),
    );
    await screen.findByTestId('signup-confirm');
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
    for (const reply of [() => json({ error: { code: 'RATE_LIMITED', message: 'x' } }, 429), () => json({ available: false, suggestions: [], attribution: null }), () => Promise.reject(new TypeError('network'))]) {
      let completed = false;
      const { unmount } = verifyWith(
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith('/preview')) return json(PREVIEW);
          if (url.endsWith('/address/suggest')) return reply();
          if (url.endsWith('/complete')) {
            completed = true;
            return json(DONE);
          }
          return json({}, 401);
        }),
      ).view;
      await screen.findByTestId('signup-confirm');
      fireEvent.change(screen.getByLabelText('Street address'), { target: { value: '100 Main St' } });
      await new Promise((r) => setTimeout(r, 350));
      expect(suggestions()).toHaveLength(0);
      expect(screen.queryByRole('alert')).toBeNull();
      fillRequired();
      fireEvent.click(screen.getByTestId('signup-create'));
      await screen.findByTestId('signup-done');
      expect(completed).toBe(true);
      unmount();
    }
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

  // Aramo Sign Personal (Free) — the Personal link appears only while the Personal
  // mode is not off (its public terms route answers 404 when off).
  it('offers the free personal account only when the Personal terms route does not 404', async () => {
    const withPersonal = (personalStatus: number) =>
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/v1/signup/sign/personal/terms')) return json(personalStatus === 404 ? { error: { code: 'NOT_FOUND' } } : { documents: null }, personalStatus);
        if (url.endsWith('/v1/signup/sign/terms')) return json({ terms: null });
        return json({}, 401);
      });
    vi.stubGlobal('fetch', withPersonal(200));
    const { unmount } = at('/signup');
    const link = await screen.findByTestId('signup-personal-link');
    expect(link).toHaveTextContent('Signing up for yourself? Create a free personal account');
    expect(within(link).getByRole('link')).toHaveAttribute('href', '/signup/personal');
    unmount();
    const off = withPersonal(404);
    vi.stubGlobal('fetch', off);
    at('/signup');
    await screen.findByTestId('signup-form');
    await waitFor(() => expect(off.mock.calls.some(([u]) => String(u).endsWith('/personal/terms'))).toBe(true));
    // Let the 404 settle, then the link is still absent.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('signup-personal-link')).toBeNull();
  });

  it('tokenFromHash accepts only a plausible token', () => {
    expect(tokenFromHash(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash('#token=short')).toBeNull();
    expect(tokenFromHash('')).toBeNull();
  });
});
