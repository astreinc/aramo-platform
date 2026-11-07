// M-A14 §1 items 1–2 — "+ › Sign Document" opens the Add Documents sheet over Home: Scan,
// Photos, Templates (Personal: the plans paywall), Files; never Email or a cloud tile
// (R-7). A picked document is handed to Sign Document in memory.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { AppServices } from '../../../app/services';
import { ServicesProvider } from '../../../app/ServicesContext';
import { workspaceWith } from '../../inbox/__tests__/fixtures';
import { SelfSignEntrySheet, selfTemplatesTile } from '../SelfSignEntrySheet';
import { takePendingSelfDocs } from '../selfSignHandoff';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: mockNavigate }),
}));
const mockPick = jest.fn();
jest.mock('../../send/sources', () => ({ scanToPdf: jest.fn(), pickPdf: () => mockPick() }));
jest.mock('../../send/photos', () => ({ pickPhotosToPdf: jest.fn() }));
jest.setTimeout(30_000);
const WAIT = { timeout: 10_000 } as const;

let kind: 'PERSONAL' | 'BUSINESS' = 'PERSONAL';
let templates = false;
let qc: QueryClient;
afterEach(() => qc?.clear());
beforeEach(() => {
  kind = 'PERSONAL';
  templates = false;
  takePendingSelfDocs();
});

function renderSheet() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const { workspace } = workspaceWith(() => ({
    status: 200,
    body: {
      user: { id: 'u1', email: 'me@example.com', display_name: 'Sam Example' },
      tenant: { kind },
      can_send: true,
      features: { templates },
      permissions: { templates },
    },
  }));
  const onClose = jest.fn();
  render(
    <ServicesProvider services={{ workspace } as unknown as AppServices}>
      <QueryClientProvider client={qc}>
        <SelfSignEntrySheet visible onClose={onClose} />
      </QueryClientProvider>
    </ServicesProvider>,
  );
  return { onClose };
}

const tiles = () => screen.queryAllByTestId(/^self-source-/).map((n) => n.props.testID);

describe('Add Documents sheet over Home (a03)', () => {
  it('Scan, Photos, Templates and Files on a Personal account; no Email or cloud tiles (R-7)', async () => {
    renderSheet();
    expect(screen.getByText('Add Documents')).toBeTruthy();
    await waitFor(() => expect(tiles()).toEqual(['self-source-scan', 'self-source-photos', 'self-source-templates', 'self-source-files']), WAIT);
    for (const label of ['Email', 'Google', 'OneDrive', 'Box', 'Dropbox']) expect(screen.queryByText(label)).toBeNull();
  });

  it('Templates on a Free Personal account opens Plans (today’s paywall rule)', async () => {
    const { onClose } = renderSheet();
    await waitFor(() => expect(screen.getByTestId('self-source-templates')).toBeTruthy(), WAIT);
    await act(async () => {
      fireEvent.press(screen.getByTestId('self-source-templates'));
    });
    expect(onClose).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('Plans', { from: 'templates' });
  });

  it('Templates on a Free Personal account carries the Upgrade tag', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('upgrade-tag-templates')).toBeTruthy(), WAIT);
    expect(screen.getByText('Upgrade')).toBeTruthy();
    expect(screen.getByLabelText('Templates, available with upgrade')).toBeTruthy();
  });

  it('no Upgrade tag when the plan includes templates', async () => {
    templates = true;
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('self-source-templates')).toBeTruthy(), WAIT);
    expect(screen.queryByTestId('upgrade-tag-templates')).toBeNull();
  });

  it('a picked file is handed to Sign Document, which opens', async () => {
    const pdf = new Uint8Array(Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1'));
    mockPick.mockResolvedValueOnce({ kind: 'document', title: 'Lease', filename: 'Lease.pdf', bytes: pdf });
    const { onClose } = renderSheet();
    await act(async () => {
      fireEvent.press(screen.getByTestId('self-source-files'));
    });
    expect(onClose).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('SelfSign');
    const handed = takePendingSelfDocs();
    expect(handed.map((p) => [p.doc.title, p.source])).toEqual([['Lease', 'Files']]);
  });

  it('a cancelled picker keeps the sheet', async () => {
    mockPick.mockResolvedValueOnce({ kind: 'cancelled' });
    const { onClose } = renderSheet();
    await act(async () => {
      fireEvent.press(screen.getByTestId('self-source-files'));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('selfTemplatesTile', () => {
  it('allowed → shown; Personal without → shown (paywall); Business without → hidden', () => {
    const ctx = (k: string, on: boolean) => ({ tenant: { kind: k }, features: { templates: on }, permissions: { templates: on } }) as never;
    expect(selfTemplatesTile(ctx('BUSINESS', true))).toEqual({ allowed: true, show: true });
    expect(selfTemplatesTile(ctx('PERSONAL', false))).toEqual({ allowed: false, show: true });
    expect(selfTemplatesTile(ctx('BUSINESS', false))).toEqual({ allowed: false, show: false });
  });
});
