import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ApiError, configureAuthConsumer, type SignInMethod } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SenderContext } from '../api';
import { WorkspaceProvider } from '../workspace';

import { SignInMethodsSection } from './SignInMethods';

// Apple Go-Live A1 L-3 path 1 / L-7 — Settings → Sign-in methods: list, Add
// (signed-in link), Remove with a confirmation, the last method can't be removed.

vi.mock('@aramo/document-templates-web/pdf', async (importOriginal) => ({ ...(await importOriginal<object>()), loadPdf: vi.fn() }));

const PERSONAL: SenderContext = {
  user: { id: 'u1', email: 'pat@gmail.com', display_name: 'Pat Lee' },
  tenant: { id: 't1', name: 'Pat Lee', kind: 'PERSONAL' },
  workspace: 'personal',
  permissions: { read: true, create: true, send: true },
  can_send: true,
  personal_sending_enabled: true,
  organization_url: null,
  app_home_url: null,
};
const BUSINESS: SenderContext = { ...PERSONAL, tenant: { id: 't1', name: 'Northwind', kind: 'BUSINESS' }, workspace: 'sign' };

const GOOGLE: SignInMethod = { idp: 'google', email_snapshot: 'pat@gmail.com', linked_at: '2026-10-01T00:00:00Z' };
const APPLE: SignInMethod = { idp: 'apple', email_snapshot: 'abc@privaterelay.appleid.com', linked_at: '2026-11-08T00:00:00Z' };

function Probe() {
  const l = useLocation();
  return <span data-testid="probe">{`${l.pathname}${l.search}`}</span>;
}

function renderSection(
  props: Parameters<typeof SignInMethodsSection>[0],
  { ctx = PERSONAL, path = '/personal/settings/personal' }: { ctx?: SenderContext; path?: string } = {},
) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ awaiting_signatures: 0 }), { status: 200 })));
  return render(
    <MemoryRouter initialEntries={[path]}>
      <WorkspaceProvider ctx={ctx}>
        <SignInMethodsSection {...props} />
        <Probe />
      </WorkspaceProvider>
    </MemoryRouter>,
  );
}

describe('Settings → Sign-in methods', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => {
    vi.unstubAllGlobals();
    configureAuthConsumer('recruiter');
  });

  it('lists the linked methods and offers to add the missing Personal provider (Apple) via the signed-in link', async () => {
    const onNavigate = vi.fn();
    renderSection({ loader: vi.fn().mockResolvedValue([GOOGLE]), onNavigate });
    expect(await screen.findByTestId('sign-in-method-google')).toHaveTextContent('pat@gmail.com');
    // Personal: Google + Apple only (Apple Go-Live R-4); Microsoft is never offered.
    expect(screen.queryByTestId('sign-in-method-add-microsoft')).toBeNull();
    expect(screen.queryByTestId('sign-in-method-add-google')).toBeNull();
    fireEvent.click(screen.getByTestId('sign-in-method-add-apple'));
    expect(onNavigate).toHaveBeenCalledWith('/auth/sign/link?idp=apple&return=%2Fpersonal%2Fsettings%2Fpersonal');
  });

  it('a Business account may add Microsoft, Google or Apple', async () => {
    renderSection({ loader: vi.fn().mockResolvedValue([GOOGLE]) }, { ctx: BUSINESS, path: '/sign/settings/personal' });
    await screen.findByTestId('sign-in-method-add-microsoft');
    expect(screen.getByTestId('sign-in-method-add-apple')).toBeTruthy();
  });

  it('?linked=apple shows the success notice and is cleared from the URL', async () => {
    renderSection({ loader: vi.fn().mockResolvedValue([GOOGLE, APPLE]) }, { path: '/personal/settings/personal?linked=apple' });
    expect(screen.getByTestId('sign-in-methods-notice')).toHaveTextContent('Apple is connected. You can now sign in with it.');
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('/personal/settings/personal'));
    expect(await screen.findByTestId('sign-in-method-apple')).toHaveTextContent('abc@privaterelay.appleid.com');
  });

  it('?link_error= shows the refusal in plain words', async () => {
    renderSection({ loader: vi.fn().mockResolvedValue([GOOGLE]) }, { path: '/personal/settings/personal?link_error=identity_already_linked' });
    expect(screen.getByTestId('sign-in-methods-notice')).toHaveTextContent('That account is already connected to a different Aramo account.');
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('/personal/settings/personal'));
  });

  it('Remove asks to confirm, then removes and reloads', async () => {
    const loader = vi.fn().mockResolvedValueOnce([GOOGLE, APPLE]).mockResolvedValueOnce([GOOGLE]);
    const remover = vi.fn().mockResolvedValue(undefined);
    renderSection({ loader, remover });
    fireEvent.click(await screen.findByTestId('sign-in-method-remove-apple'));
    expect(screen.getByText('Remove Apple?')).toBeTruthy();
    expect(remover).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('sign-in-method-confirm-apple'));
    expect(await screen.findByText('Apple was removed. You can no longer sign in with it.')).toBeTruthy();
    expect(remover).toHaveBeenCalledWith('apple');
    await waitFor(() => expect(screen.queryByTestId('sign-in-method-apple')).toBeNull());
  });

  it('the last method can’t be removed (409)', async () => {
    const remover = vi.fn().mockRejectedValue(new ApiError(409, 'conflict', 'CONFLICT', { reason: 'last_sign_in_method' }));
    renderSection({ loader: vi.fn().mockResolvedValue([GOOGLE]), remover });
    fireEvent.click(await screen.findByTestId('sign-in-method-remove-google'));
    fireEvent.click(screen.getByTestId('sign-in-method-confirm-google'));
    expect(await screen.findByText('This is your only sign-in method, so it can’t be removed. Add another one first.')).toBeTruthy();
    expect(screen.getByTestId('sign-in-method-google')).toBeTruthy();
  });

  it('a load failure says so', async () => {
    renderSection({ loader: vi.fn().mockRejectedValue(new Error('x')) });
    expect(await screen.findByText('We couldn’t load your sign-in methods. Try again later.')).toBeTruthy();
  });
});
