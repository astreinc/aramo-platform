// Apple Go-Live A1 L-4 / L-7 — Account → Sign-in methods (list, Add = path 1, Remove with
// the last-method refusal) and R-8 — best-effort Apple revocation before deletion.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { ApiError, clientError } from '../../../api/errors';
import type { AppServices } from '../../../app/services';
import { ServicesProvider } from '../../../app/ServicesContext';
import { createWorkspaceClient } from '../../../api/workspaceClient';
import { recordingFetch } from '../../../testing/fakes';
import { appleLinked, revokeAppleBestEffort } from '../appleRevoke';
import { SignInMethodsSection } from '../SignInMethodsSection';
import {
  addableProviders,
  linkWithWorkspace,
  loadSignInMethods,
  removeSignInMethod,
} from '../signInMethods';

jest.setTimeout(30_000);

const GOOGLE = {
  idp: 'google' as const,
  email_snapshot: 'pat@gmail.com',
  linked_at: '2026-11-01T00:00:00Z',
};
const APPLE = { idp: 'apple' as const, email_snapshot: null, linked_at: '2026-11-02T00:00:00Z' };

function workspaceWith(responder: Parameters<typeof recordingFetch>[0]) {
  const net = recordingFetch(responder);
  const workspace = createWorkspaceClient({
    baseUrl: 'https://sign.aramo.ai',
    fetch: net.fetch,
    session: {
      getAccessToken: async () => 'access-1',
      refreshAccessToken: async () => null,
      sessionExpired: () => undefined,
    },
  });
  return { net, workspace };
}

describe('sign-in methods transport (A1 L-4)', () => {
  it('lists with the Bearer token and consumer=sign, in provider order', async () => {
    const { net, workspace } = workspaceWith(() => ({
      status: 200,
      body: { items: [APPLE, { idp: 'other', email_snapshot: null, linked_at: 'x' }, GOOGLE] },
    }));
    await expect(loadSignInMethods(workspace)).resolves.toEqual([GOOGLE, APPLE]);
    expect(net.calls[0]!.url).toBe('https://sign.aramo.ai/auth/me/sign-in-methods?consumer=sign');
    expect(net.calls[0]!.headers['Authorization']).toBe('Bearer access-1');
  });

  it('removes by idp; the last method is refused with 409 last_sign_in_method', async () => {
    const { net, workspace } = workspaceWith(() => ({
      status: 409,
      body: {
        error: {
          code: 'CONFLICT',
          message: 'x',
          request_id: 'r',
          details: { reason: 'last_sign_in_method' },
        },
      },
    }));
    await expect(removeSignInMethod(workspace, 'google')).rejects.toMatchObject({
      reason: 'last_sign_in_method',
    });
    expect(net.calls[0]).toMatchObject({
      method: 'DELETE',
      url: 'https://sign.aramo.ai/auth/me/sign-in-methods/google?consumer=sign',
    });
  });

  it('links with POST /auth/native/sign/link and validates {linked, idp}', async () => {
    const { net, workspace } = workspaceWith(() => ({
      status: 200,
      body: { linked: true, idp: 'apple' },
    }));
    const body = {
      code: 'c',
      code_verifier: 'v',
      redirect_uri: 'r',
      nonce: 'n',
      device: { installation_id: 'i', platform: 'ios' as const, app_version: '1' },
    };
    await expect(linkWithWorkspace(workspace)(body)).resolves.toEqual({
      linked: true,
      idp: 'apple',
    });
    expect(net.calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://sign.aramo.ai/auth/native/sign/link',
      body,
    });
  });

  it('offers only providers not yet linked', () => {
    expect(addableProviders([GOOGLE])).toEqual(['microsoft', 'apple']);
    expect(addableProviders([GOOGLE, APPLE])).toEqual(['microsoft']);
  });
});

describe('Sign-in methods section (A1 L-7)', () => {
  let qc: QueryClient;
  afterEach(() => qc?.clear());

  function renderSection(items: unknown[], over: Partial<AppServices> = {}) {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const request = jest.fn(async (req: { method: string; path: string }) => {
      if (req.method === 'GET') return { status: 200, data: { items }, etag: null, headers: {} };
      return { status: 204, data: undefined, etag: null, headers: {} };
    });
    const linkProvider = jest.fn(async () => ({ linked: true as const, idp: 'apple' as const }));
    const services = { workspace: { request }, linkProvider, ...over } as unknown as AppServices;
    render(
      <ServicesProvider services={services}>
        <QueryClientProvider client={qc}>
          <SignInMethodsSection online />
        </QueryClientProvider>
      </ServicesProvider>,
    );
    return { request, linkProvider };
  }

  it('lists the linked methods and adds a provider through the auth session (path 1)', async () => {
    const { linkProvider } = renderSection([GOOGLE]);
    expect(await screen.findByText('Google')).toBeTruthy();
    expect(screen.getByText('pat@gmail.com')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByTestId('sign-in-method-add-apple')));
    expect(linkProvider).toHaveBeenCalledWith('apple');
  });

  it('Remove asks first, then deletes', async () => {
    const { request } = renderSection([GOOGLE, APPLE]);
    fireEvent.press(await screen.findByTestId('sign-in-method-remove-apple'));
    expect(screen.getByText('Remove Apple?')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByTestId('sign-in-method-remove-confirm')));
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'DELETE', path: '/auth/me/sign-in-methods/apple' }),
    );
  });
});

describe('Apple token revocation on deletion (R-8)', () => {
  it('knows an Apple account from the provider or the linked methods', () => {
    expect(appleLinked('apple', undefined)).toBe(true);
    expect(appleLinked('google', [GOOGLE, APPLE])).toBe(true);
    expect(appleLinked('google', [GOOGLE])).toBe(false);
  });

  it('iOS: the native sheet code is posted with client ios', async () => {
    const request = jest.fn(async () => ({
      status: 202,
      data: {},
      etag: null,
      headers: new Headers(),
    }));
    const ok = await revokeAppleBestEffort({
      platform: 'ios',
      workspace: { request } as never,
      appleAuthorizationCode: async () => 'apple-code',
      openBrowser: jest.fn(),
    });
    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/sign/me/apple/revoke',
      body: { authorization_code: 'apple-code', client: 'ios' },
    });
  });

  it('Android: asks for the Apple authorize URL (format=json) and opens it; a null url skips', async () => {
    const openBrowser = jest.fn(async () => undefined);
    const request = jest
      .fn()
      .mockResolvedValueOnce({ data: { url: 'https://appleid.apple.com/auth/authorize?x=1' } })
      .mockResolvedValueOnce({ data: { url: null } });
    const deps = {
      platform: 'android',
      workspace: { request } as never,
      appleAuthorizationCode: jest.fn(),
      openBrowser,
    };
    await expect(revokeAppleBestEffort(deps)).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      path: '/v1/sign/me/apple/revoke/start',
      query: { return: '/', format: 'json' },
    });
    expect(openBrowser).toHaveBeenCalledWith('https://appleid.apple.com/auth/authorize?x=1');
    await expect(revokeAppleBestEffort(deps)).resolves.toBe(false);
    expect(openBrowser).toHaveBeenCalledTimes(1);
  });

  it('never throws: a cancelled sheet or a server error is swallowed', async () => {
    await expect(
      revokeAppleBestEffort({
        platform: 'ios',
        workspace: { request: jest.fn() } as never,
        appleAuthorizationCode: async () => Promise.reject(clientError('auth_cancelled')),
        openBrowser: jest.fn(),
      }),
    ).resolves.toBe(false);
    await expect(
      revokeAppleBestEffort({
        platform: 'ios',
        workspace: {
          request: jest.fn(async () =>
            Promise.reject(new ApiError({ status: 500, code: 'X', reason: 'X' })),
          ),
        } as never,
        appleAuthorizationCode: async () => 'c',
        openBrowser: jest.fn(),
      }),
    ).resolves.toBe(false);
  });
});
