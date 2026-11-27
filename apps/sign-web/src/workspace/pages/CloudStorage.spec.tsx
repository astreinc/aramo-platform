import { ApiError } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CloudApi, CloudProviderRow } from '../cloud-storage-api';

// SIGN-FREE-PARITY-1 S6 (FP-R7) — Settings → Connected storage, "From cloud storage" in the
// wizard and "Save to …" on a completed envelope. Shown only while the server offers a
// provider (sender context cloud_storage).

const toast = vi.fn();
let ctx: Record<string, unknown> = { cloud_storage: ['google_drive', 'box'] };
vi.mock('../workspace', () => ({ useWorkspace: () => ({ base: '/personal', ctx, toast }) }));

import { CloudExportButton, CloudImportButton, CloudStorageSection } from './CloudStorage';

const GOOGLE: CloudProviderRow = { provider: 'google_drive', label: 'Google Drive', connected: false, account_label: null, connected_at: null, folder_choice: false };
const BOX: CloudProviderRow = { provider: 'box', label: 'Box', connected: true, account_label: 'me@example.com', connected_at: '2026-11-20T10:00:00Z', folder_choice: true };

function fakeApi(over: Partial<CloudApi> = {}): CloudApi & Record<string, ReturnType<typeof vi.fn>> {
  return {
    list: vi.fn(async () => [GOOGLE, BOX]),
    connect: vi.fn(async () => ({ authorize_url: 'https://accounts.example/authorize?x=1' })),
    disconnect: vi.fn(async () => undefined),
    items: vi.fn(async () => ({ items: [{ id: 'f1', name: 'HR', kind: 'folder', mime_type: null, size: null, modified_at: null }, { id: 'p1', name: 'Offer.pdf', kind: 'file', mime_type: 'application/pdf', size: 2048, modified_at: null }], next_cursor: null })),
    importFile: vi.fn(async () => ({ id: 'doc', revision: 3 })),
    exportExecuted: vi.fn(async () => ({ provider: 'box', folder: { id: '7', name: 'Aramo Sign' }, saved: [{ name: 'Offer (signed).pdf', web_url: null }] })),
    ...over,
  } as never;
}

function Where() {
  const l = useLocation();
  return <span data-testid="where">{`${l.pathname}${l.search}`}</span>;
}

function at(path: string, el: JSX.Element) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              {el}
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  ctx = { cloud_storage: ['google_drive', 'box'] };
});

describe('Settings → Connected storage', () => {
  it('lists the offered providers; Connect goes to the provider with this page as the return', async () => {
    const api = fakeApi();
    const go = vi.fn();
    at('/personal/settings/storage', <CloudStorageSection api={api} go={go} />);
    expect(await screen.findByTestId('cloud-row-box')).toHaveTextContent('me@example.com');
    expect(screen.getByTestId('cloud-row-google_drive')).toHaveTextContent('Not connected');
    fireEvent.click(screen.getByTestId('cloud-connect-google_drive'));
    await waitFor(() => expect(go).toHaveBeenCalledWith('https://accounts.example/authorize?x=1'));
    expect(api.connect).toHaveBeenCalledWith('google_drive', '/personal/settings/storage');
  });

  it('Disconnect asks first, then disconnects and reloads', async () => {
    const api = fakeApi();
    at('/personal/settings/storage', <CloudStorageSection api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Box' }));
    expect(api.disconnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('cloud-disconnect-confirm'));
    await waitFor(() => expect(api.disconnect).toHaveBeenCalledWith('box'));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });

  it('shows the connect result once and removes it from the address', async () => {
    at('/personal/settings/storage?cloud_storage=connected&provider=box', <CloudStorageSection api={fakeApi()} />);
    expect(await screen.findByTestId('cloud-connect-notice')).toHaveTextContent('Box is connected.');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/personal\/settings\/storage$/));
  });
});

describe('Envelope wizard → From cloud storage', () => {
  it('is hidden while no provider is offered', () => {
    ctx = { cloud_storage: [] };
    at('/personal/envelopes/e1/edit', <CloudImportButton envelopeId="e1" onImported={vi.fn()} api={fakeApi()} />);
    expect(screen.queryByTestId('from-cloud-storage')).toBeNull();
  });

  it('opens a connected provider, browses into a folder and imports the chosen PDF', async () => {
    const api = fakeApi();
    const onImported = vi.fn();
    at('/personal/envelopes/e1/edit', <CloudImportButton envelopeId="e1" onImported={onImported} api={api} />);
    fireEvent.click(screen.getByTestId('from-cloud-storage'));
    fireEvent.click(await screen.findByTestId('cloud-open-box'));
    fireEvent.click(await screen.findByTestId('cloud-item-f1'));
    await waitFor(() => expect(api.items).toHaveBeenLastCalledWith('box', { folder_id: 'f1', q: null, cursor: null, folders: false }));
    fireEvent.click(await screen.findByTestId('cloud-item-p1'));
    await waitFor(() => expect(api.importFile).toHaveBeenCalledWith('e1', 'box', 'p1'));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
  });

  it('a provider not yet connected offers Connect, returning to the wizard', async () => {
    const api = fakeApi();
    const go = vi.fn();
    at('/personal/envelopes/e1/edit', <CloudImportButton envelopeId="e1" onImported={vi.fn()} api={api} go={go} />);
    fireEvent.click(screen.getByTestId('from-cloud-storage'));
    fireEvent.click(await screen.findByTestId('cloud-connect-google_drive'));
    await waitFor(() => expect(api.connect).toHaveBeenCalledWith('google_drive', '/personal/envelopes/e1/edit'));
    expect(go).toHaveBeenCalled();
  });

  it('a refused import shows the shared refusal copy', async () => {
    const api = fakeApi({ importFile: vi.fn(async () => Promise.reject(new ApiError(409, 'x', 'INVALID_REQUEST', { reason: 'cloud_reconnect_required' }))) } as never);
    at('/personal/envelopes/e1/edit', <CloudImportButton envelopeId="e1" onImported={vi.fn()} api={api} />);
    fireEvent.click(screen.getByTestId('from-cloud-storage'));
    fireEvent.click(await screen.findByTestId('cloud-open-box'));
    fireEvent.click(await screen.findByTestId('cloud-item-p1'));
    expect(await screen.findByText(/needs to be connected again/)).toBeInTheDocument();
  });
});

describe('Envelope detail → Save to …', () => {
  it('saves to the "Aramo Sign" folder by default and says where', async () => {
    const api = fakeApi();
    at('/personal/envelopes/e1', <CloudExportButton envelopeId="e1" api={api} />);
    fireEvent.click(screen.getByTestId('save-to-cloud'));
    fireEvent.click(await screen.findByTestId('cloud-open-box'));
    fireEvent.click(await screen.findByTestId('cloud-save-default'));
    await waitFor(() => expect(api.exportExecuted).toHaveBeenCalledWith('e1', 'box', undefined));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Saved to Box in “Aramo Sign”.'));
  });

  it('a provider with folder choice can save into a chosen folder', async () => {
    const api = fakeApi();
    at('/personal/envelopes/e1', <CloudExportButton envelopeId="e1" api={api} />);
    fireEvent.click(screen.getByTestId('save-to-cloud'));
    fireEvent.click(await screen.findByTestId('cloud-open-box'));
    fireEvent.click(await screen.findByTestId('cloud-choose-folder'));
    fireEvent.click(await screen.findByTestId('cloud-item-f1'));
    fireEvent.click(await screen.findByTestId('cloud-save-here'));
    await waitFor(() => expect(api.exportExecuted).toHaveBeenCalledWith('e1', 'box', 'f1'));
  });

  it('is hidden while no provider is offered', () => {
    ctx = {};
    at('/personal/envelopes/e1', <CloudExportButton envelopeId="e1" api={fakeApi()} />);
    expect(screen.queryByTestId('save-to-cloud')).toBeNull();
  });
});
