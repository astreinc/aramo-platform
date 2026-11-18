// Aramo-Sign-Mobile-Amendment-M-A8 §2.1/§2.2 — Business users are organization-managed:
// Account shows "Your organization manages this account…" and a "Privacy requests"
// entry (ACCESS, EXPORT, CORRECTION, DELETION of eligible personal information), and no
// self-service "Delete account". Only the tenant_owner of a PERSONAL tenant keeps it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { AppServices } from '../../../app/services';
import { ServicesProvider } from '../../../app/ServicesContext';
import { PrivacyRequestsSection } from '../PrivacyRequestsSection';
import { ALREADY_OPEN_COPY, BUSINESS_MANAGED_COPY, isPersonalAccountOwner, type PrivacyRequest } from '../privacy';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => undefined) }));

const WAIT = { timeout: 10_000 } as const;
jest.setTimeout(30_000);

const created = (request_type: PrivacyRequest['request_type'], status: PrivacyRequest['status'] = 'DATA_INVENTORY'): PrivacyRequest => ({
  reference: 'PR-AAAA-BBBB-CCCC',
  request_type,
  subject_kind: 'BUSINESS_MEMBER',
  channel: 'IN_APP',
  status,
  status_label: status === 'REFERRED_TO_ORGANIZATION' ? 'Referred to your organization' : 'Being reviewed by the Aramo privacy team',
  referred_to_organization: status === 'REFERRED_TO_ORGANIZATION',
  due_at: '2026-11-27T00:00:00.000Z',
  created_at: '2026-10-28T00:00:00.000Z',
  updated_at: '2026-10-28T00:00:00.000Z',
  completed_at: null,
  outcome_code: null,
  outcome_text: null,
  retained: [],
  organization_decides: status === 'REFERRED_TO_ORGANIZATION' ? 'Your organization decides about documents it sent.' : null,
  privacy_contact: 'privacy@aramo.ai',
});

let qc: QueryClient;
afterEach(() => qc?.clear());

function renderSection(opts: { repeat?: boolean } = {}) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  // UAT DEL-06 — the POST goes through workspace.request (its status says new 201 / already open 200).
  // `call` records it in the old shape so the assertions read the same.
  const call = jest.fn((_path: string, _method: string, _init: { body?: unknown }) => undefined);
  const request = jest.fn(async (req: { method: string; path: string; body?: { request_type: PrivacyRequest['request_type'] } }) => {
    if (req.path === '/v1/sign/me/privacy-requests' && req.method === 'POST') {
      call(req.path, 'post', { body: req.body });
      const t = req.body!.request_type;
      return { status: opts.repeat ? 200 : 201, data: created(t, t === 'DELETION' ? 'REFERRED_TO_ORGANIZATION' : 'DATA_INVENTORY'), etag: null, headers: new Headers() };
    }
    throw new Error(`unexpected ${req.path}`);
  });
  const signOut = jest.fn(async () => undefined);
  const services = { workspace: { call: jest.fn(), request }, signOut } as unknown as AppServices;
  render(
    <ServicesProvider services={services}>
      <QueryClientProvider client={qc}>
        <PrivacyRequestsSection online />
      </QueryClientProvider>
    </ServicesProvider>,
  );
  return { call, signOut };
}

describe('Business account — organization-managed (M-A8 §2)', () => {
  it('shows the organization-managed copy and a Privacy requests entry; never a Delete account action', async () => {
    renderSection();
    expect(await screen.findByTestId('business-managed-copy', undefined, WAIT)).toHaveTextContent(BUSINESS_MANAGED_COPY);
    expect(BUSINESS_MANAGED_COPY).toBe('Your organization manages this account. Contact your organization administrator to manage product access.');
    expect(screen.getByTestId('privacy-requests')).toBeTruthy();
    expect(screen.queryByTestId('delete-account')).toBeNull();
    expect(screen.queryByText(/Delete account/)).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('privacy-requests'));
    });
    for (const t of ['ACCESS', 'EXPORT', 'CORRECTION', 'DELETION']) expect(screen.getByTestId(`privacy-request-${t}`)).toBeTruthy();
    expect(screen.queryByText(/Delete account/)).toBeNull();
  });

  it('ACCESS: sends { request_type: ACCESS } and shows the request ID and status', async () => {
    const { call, signOut } = renderSection();
    await act(async () => {
      fireEvent.press(await screen.findByTestId('privacy-requests', undefined, WAIT));
    });
    fireEvent.press(screen.getByTestId('privacy-request-ACCESS'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('privacy-request-send'));
    });
    expect(call).toHaveBeenCalledWith('/v1/sign/me/privacy-requests', 'post', { body: { request_type: 'ACCESS' } });
    expect(await screen.findByTestId('privacy-request-reference', undefined, WAIT)).toHaveTextContent('PR-AAAA-BBBB-CCCC');
    expect(signOut).not.toHaveBeenCalled();
  });

  it('DELETION of eligible personal information: DELETE confirms; the request is referred to the organization; the app does not sign out', async () => {
    const { call, signOut } = renderSection();
    await act(async () => {
      fireEvent.press(await screen.findByTestId('privacy-requests', undefined, WAIT));
    });
    fireEvent.press(screen.getByTestId('privacy-request-DELETION'));
    fireEvent.press(screen.getByTestId('privacy-request-send'));
    expect(call).not.toHaveBeenCalled();
    fireEvent.changeText(screen.getByTestId('privacy-delete-confirm-input'), 'DELETE');
    await act(async () => {
      fireEvent.press(screen.getByTestId('privacy-request-send'));
    });
    expect(call).toHaveBeenCalledWith('/v1/sign/me/privacy-requests', 'post', { body: { request_type: 'DELETION', confirm: 'DELETE' } });
    expect(await screen.findByTestId('privacy-request-status', undefined, WAIT)).toHaveTextContent(/Referred to your organization/);
    await act(async () => {
      fireEvent.press(screen.getByTestId('privacy-request-done'));
    });
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe('isPersonalAccountOwner (M-A8 §2.1)', () => {
  it('follows the backend flag; a non-owner of a Personal tenant is a Business user', () => {
    expect(isPersonalAccountOwner({ personal_account_owner: true, tenant: { kind: 'PERSONAL' } })).toBe(true);
    expect(isPersonalAccountOwner({ personal_account_owner: false, tenant: { kind: 'PERSONAL' } })).toBe(false);
    expect(isPersonalAccountOwner({ personal_account_owner: false, tenant: { kind: 'BUSINESS' } })).toBe(false);
  });
  it('an older backend without the flag falls back to the tenant kind', () => {
    expect(isPersonalAccountOwner({ tenant: { kind: 'PERSONAL' } })).toBe(true);
    expect(isPersonalAccountOwner({ tenant: { kind: 'BUSINESS' } })).toBe(false);
    expect(isPersonalAccountOwner(undefined, 'PERSONAL')).toBe(true);
    expect(isPersonalAccountOwner(undefined, null)).toBe(false);
  });

  // UAT DEL-06 — a second request of the same type while one is open: the server answers the
  // open one (200), and the app says so instead of repeating the confirmation.
  it('a repeat of an open request says it is already open and shows the existing request ID', async () => {
    renderSection({ repeat: true });
    await act(async () => {
      fireEvent.press(await screen.findByTestId('privacy-requests', undefined, WAIT));
    });
    fireEvent.press(screen.getByTestId('privacy-request-ACCESS'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('privacy-request-send'));
    });
    expect(await screen.findByTestId('privacy-request-already-open', undefined, WAIT)).toHaveTextContent(ALREADY_OPEN_COPY);
    expect(screen.getByTestId('privacy-request-reference')).toHaveTextContent('PR-AAAA-BBBB-CCCC');
  });

  it('a new request does not show the already-open message', async () => {
    renderSection();
    await act(async () => {
      fireEvent.press(await screen.findByTestId('privacy-requests', undefined, WAIT));
    });
    fireEvent.press(screen.getByTestId('privacy-request-EXPORT'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('privacy-request-send'));
    });
    expect(await screen.findByTestId('privacy-request-reference', undefined, WAIT)).toBeTruthy();
    expect(screen.queryByTestId('privacy-request-already-open')).toBeNull();
  });
});
