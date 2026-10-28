// Aramo-Sign-Mobile-Amendment-M-A7 §3.3 — Account → "Delete account / Request
// deletion" for every account type. Personal: a clear deletion request; Business: the
// organization's authority + Aramo's fallback. DELETE confirms; the request ID, status
// and retained categories are shown; when the session has ended "Done" signs out
// (services.signOut also wipes temporary documents, M-A7 §4 R-7).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { AppServices } from '../../../app/services';
import { ServicesProvider } from '../../../app/ServicesContext';
import { DeleteAccountSection } from '../DeleteAccountSection';
import { deleteConfirmed, openDeletion, signOutAfter, type PrivacyRequest } from '../privacy';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => undefined) }));

const WAIT = { timeout: 10_000 } as const;
jest.setTimeout(30_000);

const REQUEST: PrivacyRequest = {
  reference: 'PR-7K3M-9QX2-H4TD',
  request_type: 'DELETION',
  subject_kind: 'ACCOUNT_HOLDER',
  channel: 'IN_APP',
  status: 'DATA_INVENTORY',
  status_label: 'Being reviewed by the Aramo privacy team',
  referred_to_organization: false,
  due_at: '2026-11-27T00:00:00.000Z',
  created_at: '2026-10-28T00:00:00.000Z',
  updated_at: '2026-10-28T00:00:00.000Z',
  completed_at: null,
  outcome_code: null,
  outcome_text: null,
  retained: [{ key: 'signing_evidence', label: 'Signed agreements and their evidence', why: 'Kept under the retention rules.' }],
  organization_decides: null,
  privacy_contact: 'privacy@aramo.ai',
};

let qc: QueryClient;
afterEach(() => qc?.clear());

function renderSection(personal: boolean, created: PrivacyRequest, items: PrivacyRequest[] = []) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const call = jest.fn(async (path: string, method: string, init: { body?: unknown }) => {
    if (path === '/v1/sign/me/privacy-requests' && method === 'get') return { items };
    if (path === '/v1/sign/me/privacy-requests' && method === 'post') {
      expect(init.body).toEqual({ request_type: 'DELETION', confirm: 'DELETE' });
      return created;
    }
    throw new Error(`unexpected ${path}`);
  });
  const signOut = jest.fn(async () => undefined);
  const services = { workspace: { call }, signOut } as unknown as AppServices;
  render(
    <ServicesProvider services={services}>
      <QueryClientProvider client={qc}>
        <DeleteAccountSection personal={personal} online />
      </QueryClientProvider>
    </ServicesProvider>,
  );
  return { call, signOut };
}

describe('Delete account (M-A7 §3.3)', () => {
  it('Personal: DELETE confirms; shows the request ID, status and what is kept; Done signs out', async () => {
    const { call, signOut } = renderSection(true, REQUEST);
    await act(async () => {
      fireEvent.press(await screen.findByTestId('delete-account', undefined, WAIT));
    });
    expect(screen.getByText(/sending stops/)).toBeTruthy();
    expect(screen.getByText(/We keep only what we must/)).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('delete-confirm-input'), 'delete me');
    fireEvent.press(screen.getByTestId('delete-account-confirm'));
    expect(call).not.toHaveBeenCalledWith('/v1/sign/me/privacy-requests', 'post', expect.anything());
    fireEvent.changeText(screen.getByTestId('delete-confirm-input'), 'DELETE');
    await act(async () => {
      fireEvent.press(screen.getByTestId('delete-account-confirm'));
    });
    expect(await screen.findByTestId('delete-account-reference', undefined, WAIT)).toHaveTextContent('PR-7K3M-9QX2-H4TD');
    expect(screen.getByTestId('delete-account-status')).toHaveTextContent(/Being reviewed/);
    expect(screen.getByText(/Signed agreements and their evidence/)).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('delete-account-done'));
    });
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1), WAIT);
  });

  it('Business: explains the organization’s authority and Aramo’s fallback; stays signed in until completed', async () => {
    const referred = { ...REQUEST, subject_kind: 'BUSINESS_MEMBER' as const, status: 'REFERRED_TO_ORGANIZATION' as const, referred_to_organization: true, organization_decides: 'Your organization decides about documents it sent.' };
    const { signOut } = renderSection(false, referred);
    await act(async () => {
      fireEvent.press(await screen.findByTestId('delete-account', undefined, WAIT));
    });
    expect(screen.getByText(/Your organization decides about documents it sent or that you received/)).toBeTruthy();
    expect(screen.getByText(/Aramo stays responsible/)).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('delete-confirm-input'), 'DELETE');
    await act(async () => {
      fireEvent.press(screen.getByTestId('delete-account-confirm'));
    });
    expect(await screen.findByText('Your organization decides about documents it sent.', undefined, WAIT)).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('delete-account-done'));
    });
    expect(signOut).not.toHaveBeenCalled();
  });

  it('an open request is shown instead of a new one', async () => {
    renderSection(true, REQUEST, [REQUEST]);
    const button = await screen.findByText('Deletion requested — view status', undefined, WAIT);
    await act(async () => {
      fireEvent.press(button);
    });
    expect(screen.getByTestId('delete-account-reference')).toHaveTextContent('PR-7K3M-9QX2-H4TD');
    expect(screen.queryByTestId('delete-confirm-input')).toBeNull();
  });

  it('model helpers', () => {
    expect(deleteConfirmed('delete')).toBe(false);
    expect(deleteConfirmed(' DELETE ')).toBe(true);
    expect(openDeletion([{ ...REQUEST, completed_at: '2026-10-29T00:00:00.000Z' }])).toBeNull();
    expect(signOutAfter(REQUEST, true)).toBe(true);
    expect(signOutAfter({ ...REQUEST, status: 'REFERRED_TO_ORGANIZATION' }, false)).toBe(false);
    expect(signOutAfter({ ...REQUEST, status: 'COMPLETED' }, false)).toBe(true);
  });
});
