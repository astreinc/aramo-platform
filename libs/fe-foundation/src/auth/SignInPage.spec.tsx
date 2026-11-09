import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

import { configureAppBasePath, configureAuthConsumer } from './consumer';
import { AUTH_PRODUCTS } from './AuthShell';
import { SignInPage, allowedConsumer, providersFrom, safeReturnTo } from './SignInPage';

// AUTH-SIGNIN-1 §3.4 — buttons per options, fail-open, error display, consumer allowlist.

afterEach(() => {
  configureAuthConsumer('recruiter');
  configureAppBasePath('');
  vi.unstubAllGlobals();
});

function renderPage(search: string, options: Promise<unknown> = Promise.resolve({ providers: ['microsoft', 'google'] })) {
  const onNavigate = vi.fn();
  const fetchLoginOptions = vi.fn().mockReturnValue(options);
  render(
    <MemoryRouter initialEntries={[`/login${search}`]}>
      <SignInPage onNavigate={onNavigate} fetchLoginOptions={fetchLoginOptions} product={AUTH_PRODUCTS.ats} />
    </MemoryRouter>,
  );
  return { onNavigate, fetchLoginOptions };
}

describe('SignInPage', () => {
  it('renders one button per provider, Microsoft first, and never navigates on mount', async () => {
    const { onNavigate } = renderPage('', Promise.resolve({ providers: ['google', 'microsoft'] }));
    const buttons = await screen.findAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Continue with Microsoft', 'Continue with Google']);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByText('Sign in to Aramo ATS with your work account.')).toBeTruthy();
    expect(screen.getByText('Welcome back')).toBeTruthy();
  });

  it('a pinned host shows only its provider, with the single sign-on note', async () => {
    renderPage('', Promise.resolve({ providers: ['microsoft'] }));
    await screen.findByTestId('signin-microsoft');
    expect(screen.queryByTestId('signin-google')).toBeNull();
    expect(screen.getByText(/Aramo never sees your password/)).toBeTruthy();
  });

  it('a deep link shows the return note', async () => {
    renderPage('?return_to=%2Fats%2Frequisitions');
    expect(screen.getByTestId('signin-return-note')).toBeTruthy();
  });

  it('fails open to both buttons when login-options fails (UI fallback only)', async () => {
    renderPage('', Promise.reject(new Error('network')));
    await screen.findByTestId('signin-microsoft');
    expect(screen.getByTestId('signin-google')).toBeTruthy();
  });

  it('fails open on an unusable login-options body', async () => {
    renderPage('', Promise.resolve({ providers: ['okta'] }));
    await screen.findByTestId('signin-google');
    expect(screen.getByTestId('signin-microsoft')).toBeTruthy();
  });

  it('a button navigates to the auth-service login with idp and the page return_to', async () => {
    const { onNavigate } = renderPage('?return_to=%2Fats%2Frequisitions');
    fireEvent.click(await screen.findByTestId('signin-google'));
    expect(onNavigate).toHaveBeenCalledWith('/auth/recruiter/login?idp=google&return_to=%2Fats%2Frequisitions');
  });

  it('drops an unsafe return_to', async () => {
    const { onNavigate } = renderPage('?return_to=%2F%2Fevil.example');
    fireEvent.click(await screen.findByTestId('signin-microsoft'));
    expect(onNavigate).toHaveBeenCalledWith('/auth/recruiter/login?idp=microsoft');
  });

  it('?error=CODE shows the message with the buttons', async () => {
    renderPage('?error=TENANT_SUSPENDED&consumer=recruiter');
    expect(screen.getByText('Workspace suspended')).toBeTruthy();
    await screen.findByTestId('signin-microsoft');
  });

  it('a terminal error shows no buttons', async () => {
    const { fetchLoginOptions } = renderPage('?error=TENANT_CLOSED');
    expect(screen.getByText('Workspace closed')).toBeTruthy();
    await waitFor(() => expect(fetchLoginOptions).toHaveBeenCalled());
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('TENANT_ACCESS_DENIED keeps the wrong-account recovery (select_account)', () => {
    const { onNavigate } = renderPage('?error=TENANT_ACCESS_DENIED&consumer=recruiter');
    expect(screen.getByText('Signed in with a different account')).toBeTruthy();
    fireEvent.click(screen.getByText('Sign in with a different account', { selector: 'button' }));
    expect(onNavigate).toHaveBeenCalledWith('/auth/recruiter/login?select_account=1');
  });

  it('a provider-policy denial names no account and offers the buttons', async () => {
    renderPage('?error=TENANT_ACCESS_DENIED&consumer=recruiter&reason=idp_not_permitted_for_tenant');
    await screen.findByTestId('signin-microsoft');
    expect(screen.getByText('Use your organization’s sign-in provider')).toBeTruthy();
  });

  it('on a pinned host the provider-policy denial names the organization’s provider', async () => {
    renderPage('?error=TENANT_ACCESS_DENIED&reason=idp_not_permitted_for_tenant', Promise.resolve({ providers: ['microsoft'] }));
    expect(await screen.findByText('Your organization uses Microsoft for sign-in.')).toBeTruthy();
    expect(screen.queryByTestId('signin-google')).toBeNull();
  });

  it('a canceled provider sign-in says so and offers the buttons', async () => {
    renderPage('?error=VALIDATION_ERROR&reason=cognito_error');
    expect(screen.getByText('Sign-in was canceled')).toBeTruthy();
    await screen.findByTestId('signin-google');
  });

  it('an unverified Microsoft email says why and how to fix it, with the buttons and a different-account option', async () => {
    renderPage('?error=VALIDATION_ERROR&reason=idp_email_unverified');
    expect(screen.getByText('Your Microsoft account’s email isn’t verified')).toBeTruthy();
    expect(screen.getByText(/give the account a mailbox/)).toBeTruthy();
    expect(screen.queryByText('Sign-in was canceled')).toBeNull();
    await screen.findByTestId('signin-google');
    expect(screen.getByRole('button', { name: 'Sign in with a different account' })).toBeTruthy();
  });

  it('the unverified-email screen wins over an app’s generic VALIDATION_ERROR copy', () => {
    render(
      <MemoryRouter initialEntries={['/login?error=VALIDATION_ERROR&reason=idp_email_unverified']}>
        <SignInPage
          fetchLoginOptions={vi.fn().mockResolvedValue({ providers: ['microsoft', 'google'] })}
          errorCopy={{ VALIDATION_ERROR: { title: 'Your session ended.', message: 'Sign in again to continue.', retry: true } }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Your Microsoft account’s email isn’t verified')).toBeTruthy();
    expect(screen.queryByText('Your session ended.')).toBeNull();
  });

  it('accountLinks render under the sign-in buttons and on the no-account screen only', async () => {
    const links = <a href="/signup/personal">Create a Personal account</a>;
    const fetchLoginOptions = vi.fn().mockResolvedValue({ providers: ['microsoft', 'google'] });
    const { unmount } = render(
      <MemoryRouter initialEntries={['/login']}>
        <SignInPage fetchLoginOptions={fetchLoginOptions} accountLinks={links} />
      </MemoryRouter>,
    );
    await screen.findByTestId('signin-google');
    expect(screen.getByRole('link', { name: 'Create a Personal account' })).toBeTruthy();
    unmount();
    const second = render(
      <MemoryRouter initialEntries={['/login?error=INSUFFICIENT_PERMISSIONS']}>
        <SignInPage fetchLoginOptions={fetchLoginOptions} accountLinks={links} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Create a Personal account' })).toBeTruthy();
    second.unmount();
    render(
      <MemoryRouter initialEntries={['/login?error=TENANT_SUSPENDED']}>
        <SignInPage fetchLoginOptions={fetchLoginOptions} accountLinks={links} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: 'Create a Personal account' })).toBeNull();
  });

  it('no Aramo account: no JIT message', () => {
    renderPage('?error=INSUFFICIENT_PERMISSIONS');
    expect(screen.getByText('We couldn’t find an Aramo account for you')).toBeTruthy();
  });

  it('honours an allowlisted ?consumer= (tenant host: org from the ATS app), dropping return_to', async () => {
    const { onNavigate, fetchLoginOptions } = renderPage('?error=INVALID_TOKEN&consumer=org&return_to=%2Fats%2Fx');
    fireEvent.click(await screen.findByTestId('signin-microsoft'));
    expect(fetchLoginOptions).toHaveBeenCalledWith('org');
    expect(onNavigate).toHaveBeenCalledWith('/auth/org/login?idp=microsoft');
  });

  it('ignores a ?consumer= outside the allowlist', async () => {
    const { onNavigate } = renderPage('?error=INVALID_TOKEN&consumer=platform');
    fireEvent.click(await screen.findByTestId('signin-microsoft'));
    expect(onNavigate).toHaveBeenCalledWith('/auth/recruiter/login?idp=microsoft');
  });
});

describe('SignInPage — Apple (Apple Go-Live W3)', () => {
  it('Apple is the third provider, on a black button with the Apple label', async () => {
    renderPage('', Promise.resolve({ providers: ['apple', 'google', 'microsoft'] }));
    const buttons = await screen.findAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Continue with Microsoft', 'Continue with Google', 'Continue with Apple']);
    expect(screen.getByTestId('signin-apple').className).toContain('aramo-auth__btn--apple');
    expect(screen.getByTestId('signin-google').className).not.toContain('aramo-auth__btn--apple');
  });

  it('the Apple button goes to the auth-service login with idp=apple', async () => {
    const { onNavigate } = renderPage('', Promise.resolve({ providers: ['microsoft', 'google', 'apple'] }));
    fireEvent.click(await screen.findByTestId('signin-apple'));
    expect(onNavigate).toHaveBeenCalledWith('/auth/recruiter/login?idp=apple');
  });

  it('the fallback (login-options failed) shows all three providers', async () => {
    renderPage('', Promise.reject(new Error('network')));
    await screen.findByTestId('signin-apple');
    expect(screen.getByTestId('signin-microsoft')).toBeTruthy();
  });

  it('a host pinned to Apple shows only Apple with its note', async () => {
    renderPage('', Promise.resolve({ providers: ['apple'] }));
    await screen.findByTestId('signin-apple');
    expect(screen.getByText('Sign-in through your Apple ID. Aramo never sees your password.')).toBeTruthy();
  });
});

// Apple Go-Live A1 L-3 / L-7 — the pending-link panels on /login.
const HANDLE = 'h'.repeat(43);

function LocationProbe() {
  const loc = useLocation();
  return <span data-testid="probe">{`${loc.pathname}${loc.search}${loc.hash}`}</span>;
}

function renderLink(path: string, extra: { newAccountAction?: ReactNode } = {}) {
  const onNavigate = vi.fn();
  render(
    <MemoryRouter initialEntries={[path]}>
      <SignInPage
        onNavigate={onNavigate}
        fetchLoginOptions={vi.fn().mockResolvedValue({ providers: ['microsoft', 'google', 'apple'] })}
        product={AUTH_PRODUCTS.sign}
        {...extra}
      />
      <LocationProbe />
    </MemoryRouter>,
  );
  return { onNavigate };
}

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('SignInPage — pending link (A1 L-3)', () => {
  it('path 3 (conflict): confirm it’s you, proof by another provider carries the handle; the fragment is stripped', async () => {
    configureAuthConsumer('sign');
    const { onNavigate } = renderLink(`/login?error=TENANT_ACCESS_DENIED&reason=idp_identity_conflict&consumer=sign#link=${HANDLE}&idp=apple`);
    expect(screen.getByText('You already have an Aramo account')).toBeTruthy();
    expect(screen.getByText('Confirm it’s you to add Apple as a way to sign in.')).toBeTruthy();
    await screen.findByTestId('link-proof-google');
    expect(screen.queryByTestId('link-proof-apple')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('/login?error=TENANT_ACCESS_DENIED&reason=idp_identity_conflict&consumer=sign'));
    // The handle survives the strip (kept in memory).
    fireEvent.click(screen.getByTestId('link-proof-google'));
    expect(onNavigate).toHaveBeenCalledWith(`/auth/sign/login?idp=google&link=${HANDLE}`);
  });

  it('path 3: email me a code → enter it → Apple is connected → Sign in with Apple', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === '/auth/link/email/start') return jsonRes({}, 202);
      if (u === '/auth/link/email/verify') {
        const body = JSON.parse(String(init?.body)) as { code: string };
        return body.code === '123456'
          ? jsonRes({ linked: true, idp: 'apple' })
          : jsonRes({ error: { code: 'VALIDATION_ERROR', details: { reason: 'code_invalid', attempts_remaining: 4 } } }, 400);
      }
      return jsonRes({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { onNavigate } = renderLink(`/login?error=TENANT_ACCESS_DENIED&reason=idp_identity_conflict#link=${HANDLE}&idp=apple`);
    fireEvent.click(screen.getByTestId('link-email-start'));
    await screen.findByTestId('link-code');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ link_handle: HANDLE });
    fireEvent.change(screen.getByTestId('link-code-input'), { target: { value: '000000' } });
    fireEvent.click(screen.getByTestId('link-code-submit'));
    expect(await screen.findByText('That code isn’t right. 4 tries left.')).toBeTruthy();
    fireEvent.change(screen.getByTestId('link-code-input'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('link-code-submit'));
    expect(await screen.findByText('Apple is connected')).toBeTruthy();
    const signIn = screen.getByTestId('link-signin');
    expect(signIn.textContent).toBe('Sign in with Apple');
    fireEvent.click(signIn);
    expect(onNavigate).toHaveBeenCalledWith('/auth/recruiter/login?idp=apple');
  });

  it('an expired link restarts sign-in with the provider', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) =>
        String(url).endsWith('/start') ? jsonRes({}, 202) : jsonRes({ error: { details: { reason: 'link_expired' } } }, 400),
      ),
    );
    renderLink(`/login?error=TENANT_ACCESS_DENIED&reason=idp_identity_conflict#link=${HANDLE}&idp=apple`);
    fireEvent.click(screen.getByTestId('link-email-start'));
    fireEvent.change(await screen.findByTestId('link-code-input'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('link-code-submit'));
    expect(await screen.findByTestId('link-expired')).toBeTruthy();
  });

  it('path 2 (no account): connect with the account email, and create a new account', async () => {
    const fetchMock = vi.fn<(u: RequestInfo | URL, i?: RequestInit) => Promise<Response>>(async () => jsonRes({}, 202));
    vi.stubGlobal('fetch', fetchMock);
    renderLink(`/login?error=INSUFFICIENT_PERMISSIONS&reason=user_not_provisioned#link=${HANDLE}&idp=apple`, {
      newAccountAction: <a href="/signup/personal">Create a new account</a>,
    });
    expect(screen.getByText('No Aramo account uses this Apple ID yet')).toBeTruthy();
    expect(screen.getByText('I already have an account. Connect it')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create a new account' })).toBeTruthy();
    await screen.findByTestId('link-proof-microsoft');
    fireEvent.click(screen.getByTestId('link-email-start'));
    expect(await screen.findByText('Enter the email address of your Aramo account.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('link-email-input'), { target: { value: 'pat@example.com' } });
    fireEvent.click(screen.getByTestId('link-email-start'));
    await screen.findByTestId('link-code');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      link_handle: HANDLE,
      email: 'pat@example.com',
    });
    expect(screen.getByText(/If pat@example.com belongs to an Aramo account/)).toBeTruthy();
  });

  it('a malformed fragment or an unrelated reason falls back to the normal error screen', async () => {
    renderLink('/login?error=TENANT_ACCESS_DENIED&reason=idp_identity_conflict#link=short&idp=apple');
    expect(screen.getByText('Use your organization’s sign-in provider')).toBeTruthy();
  });
});

describe('SignInPage helpers', () => {
  it('allowedConsumer', () => {
    expect(allowedConsumer(null, 'sign')).toBe('sign');
    expect(allowedConsumer('org', 'recruiter')).toBe('org');
    expect(allowedConsumer('recruiter', 'org')).toBe('recruiter');
    expect(allowedConsumer('recruiter', 'sign')).toBe('sign');
    expect(allowedConsumer('platform', 'recruiter')).toBe('recruiter');
  });

  it('safeReturnTo', () => {
    expect(safeReturnTo('/ats/x')).toBe('/ats/x');
    expect(safeReturnTo('//evil')).toBeNull();
    expect(safeReturnTo('https://evil')).toBeNull();
    expect(safeReturnTo('/\\evil')).toBeNull();
    expect(safeReturnTo(null)).toBeNull();
  });

  it('providersFrom', () => {
    expect(providersFrom({ providers: ['Google'] })).toEqual(['google']);
    expect(providersFrom({ providers: [] })).toBeNull();
    expect(providersFrom(null)).toBeNull();
  });
});
