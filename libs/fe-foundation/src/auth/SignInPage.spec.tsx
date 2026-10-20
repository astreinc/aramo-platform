import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { configureAppBasePath, configureAuthConsumer } from './consumer';
import { SignInPage, allowedConsumer, providersFrom, safeReturnTo } from './SignInPage';

// AUTH-SIGNIN-1 §3.4 — buttons per options, fail-open, error display, consumer allowlist.

afterEach(() => {
  configureAuthConsumer('recruiter');
  configureAppBasePath('');
});

function renderPage(search: string, options: Promise<unknown> = Promise.resolve({ providers: ['microsoft', 'google'] })) {
  const onNavigate = vi.fn();
  const fetchLoginOptions = vi.fn().mockReturnValue(options);
  render(
    <MemoryRouter initialEntries={[`/login${search}`]}>
      <SignInPage onNavigate={onNavigate} fetchLoginOptions={fetchLoginOptions} productName="Aramo ATS" />
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
    expect(screen.getByText('Use your work account to continue to Aramo ATS.')).toBeTruthy();
  });

  it('a pinned host shows only its provider', async () => {
    renderPage('', Promise.resolve({ providers: ['microsoft'] }));
    await screen.findByTestId('signin-microsoft');
    expect(screen.queryByTestId('signin-google')).toBeNull();
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
    expect(screen.getByText('Use your organization’s sign-in')).toBeTruthy();
    await screen.findByTestId('signin-microsoft');
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
