// SIGN-FREE-PARITY-1 S6 (FP-R7) — the app's cloud storage: transport (connect through the OS
// auth session, disconnect, save the signed copy) and the two views (hidden while dark).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { AppServices } from '../../../app/services';
import { ServicesProvider } from '../../../app/ServicesContext';
import { createWorkspaceClient } from '../../../api/workspaceClient';
import { recordingFetch } from '../../../testing/fakes';
import {
  CLOUD_APP_RETURN_URL,
  connectCloudProvider,
  disconnectCloudProvider,
  loadCloudProviders,
  saveSignedCopyToCloud,
} from '../cloudStorage';
import { CloudStorageSection, SaveToCloudButton } from '../CloudStorageViews';

jest.setTimeout(30_000);

const BOX = { provider: 'box', label: 'Box', connected: true, account_label: 'me@example.com', connected_at: '2026-11-20T10:00:00Z', folder_choice: true };
const DROPBOX = { provider: 'dropbox', label: 'Dropbox', connected: false, account_label: null, connected_at: null, folder_choice: true };

function workspaceWith(responder: Parameters<typeof recordingFetch>[0]) {
  const net = recordingFetch(responder);
  const workspace = createWorkspaceClient({
    baseUrl: 'https://sign.aramo.ai',
    fetch: net.fetch,
    session: { getAccessToken: async () => 'access-1', refreshAccessToken: async () => null, sessionExpired: () => undefined },
  });
  return { net, workspace };
}

describe('cloud storage transport', () => {
  it('lists the providers with the Bearer token', async () => {
    const { net, workspace } = workspaceWith(() => ({ status: 200, body: { providers: [BOX] } }));
    await expect(loadCloudProviders(workspace)).resolves.toEqual([BOX]);
    expect(net.calls[0]!.url).toBe('https://sign.aramo.ai/v1/sign/sender/cloud-storage');
    expect(net.calls[0]!.headers['Authorization']).toBe('Bearer access-1');
  });

  it('connects as the app: the provider page opens in the auth session and the return link decides', async () => {
    const { net, workspace } = workspaceWith(() => ({ status: 201, body: { authorize_url: 'https://www.dropbox.com/oauth2/authorize?x=1' } }));
    const openAuth = jest.fn(async () => ({ type: 'success', url: `${CLOUD_APP_RETURN_URL}?cloud_storage=connected&provider=dropbox` }));
    await expect(connectCloudProvider(workspace, 'dropbox', openAuth)).resolves.toBe('connected');
    expect(net.calls[0]).toMatchObject({ method: 'POST', url: 'https://sign.aramo.ai/v1/sign/sender/cloud-storage/dropbox/connect' });
    expect(net.calls[0]!.body).toEqual({ client: 'app' });
    expect(openAuth).toHaveBeenCalledWith('https://www.dropbox.com/oauth2/authorize?x=1', 'aramosign://cloud-storage');
  });

  it('a closed sheet is cancelled; a foreign return or a non-https URL fails', async () => {
    const { workspace } = workspaceWith(() => ({ status: 201, body: { authorize_url: 'https://x.example/a' } }));
    await expect(connectCloudProvider(workspace, 'box', async () => ({ type: 'cancel' }))).resolves.toBe('cancelled');
    await expect(connectCloudProvider(workspace, 'box', async () => ({ type: 'success', url: 'evil://x?cloud_storage=connected' }))).resolves.toBe('failed');
    const bad = workspaceWith(() => ({ status: 201, body: { authorize_url: 'javascript:alert(1)' } }));
    await expect(connectCloudProvider(bad.workspace, 'box', jest.fn())).resolves.toBe('failed');
  });

  it('disconnects and saves the signed copy', async () => {
    const { net, workspace } = workspaceWith((req) =>
      req.method === 'DELETE' ? { status: 204 } : { status: 200, body: { provider: 'box', folder: { id: '7', name: 'Aramo Sign' }, saved: [{ name: 'A (signed).pdf', web_url: null }] } },
    );
    await disconnectCloudProvider(workspace, 'box');
    expect(net.calls[0]).toMatchObject({ method: 'DELETE', url: 'https://sign.aramo.ai/v1/sign/sender/cloud-storage/box' });
    const out = await saveSignedCopyToCloud(workspace, 'e1', 'box');
    expect(out.folder.name).toBe('Aramo Sign');
    expect(net.calls[1]).toMatchObject({ method: 'POST', url: 'https://sign.aramo.ai/v1/sign/sender/envelopes/e1/cloud-export' });
    expect(net.calls[1]!.body).toEqual({ provider: 'box' });
  });
});

describe('cloud storage views', () => {
  function renderWith(node: React.ReactElement, cloud: string[]) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const call = jest.fn(async () => ({ cloud_storage: cloud }));
    const request = jest.fn(async (req: { method: string; path: string }) => {
      if (req.method === 'GET') return { status: 200, data: { providers: [DROPBOX, BOX] }, etag: null, headers: {} };
      if (req.method === 'DELETE') return { status: 204, data: undefined, etag: null, headers: {} };
      if (req.path.endsWith('/connect')) return { status: 201, data: { authorize_url: 'https://www.dropbox.com/oauth2/authorize' }, etag: null, headers: {} };
      return { status: 200, data: { provider: 'box', folder: { id: '7', name: 'Aramo Sign' }, saved: [] }, etag: null, headers: {} };
    });
    const services = { workspace: { request, call } } as unknown as AppServices;
    render(
      <ServicesProvider services={services}>
        <QueryClientProvider client={qc}>{node}</QueryClientProvider>
      </ServicesProvider>,
    );
    return { request };
  }

  it('Account → Connected storage lists the providers; Disconnect asks first', async () => {
    const { request } = renderWith(<CloudStorageSection online />, ['dropbox', 'box']);
    expect(await screen.findByText('me@example.com')).toBeTruthy();
    expect(screen.getByText('Not connected')).toBeTruthy();
    fireEvent.press(screen.getByTestId('cloud-disconnect-box'));
    await act(async () => fireEvent.press(screen.getByTestId('cloud-disconnect-confirm')));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE', path: '/v1/sign/sender/cloud-storage/box' }));
  });

  it('Connect opens the provider in the auth session', async () => {
    const openAuth = jest.fn(async () => ({ type: 'cancel' }));
    renderWith(<CloudStorageSection online openAuth={openAuth} />, ['dropbox', 'box']);
    await act(async () => fireEvent.press(await screen.findByTestId('cloud-connect-dropbox')));
    expect(openAuth).toHaveBeenCalled();
  });

  it('nothing renders while no provider is offered', async () => {
    renderWith(
      <>
        <CloudStorageSection online />
        <SaveToCloudButton envelopeId="e1" online />
      </>,
      [],
    );
    await act(async () => undefined);
    expect(screen.queryByTestId('cloud-storage-section')).toBeNull();
    expect(screen.queryByTestId('action-save-cloud')).toBeNull();
  });

  it('Save to cloud storage saves to a connected provider', async () => {
    const { request } = renderWith(<SaveToCloudButton envelopeId="e1" online />, ['dropbox', 'box']);
    fireEvent.press(await screen.findByTestId('action-save-cloud'));
    await act(async () => fireEvent.press(await screen.findByTestId('cloud-save-box')));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/v1/sign/sender/envelopes/e1/cloud-export', body: { provider: 'box' } }));
  });
});
