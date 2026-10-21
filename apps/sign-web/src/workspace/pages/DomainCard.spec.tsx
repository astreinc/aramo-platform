import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '@aramo/fe-foundation';
import { describe, expect, it, vi } from 'vitest';

import type { DomainApi, DomainDelegation, DomainView } from '../domain-api';
import { DomainDelegatePage } from '../routes/DomainDelegatePage';
import type { DelegateApi, DelegateView } from '../domain-api';

import { CONFLICT_MESSAGE, DomainCard } from './DomainCard';

// Domain-Enforcement P3 (LOCKED) §4/§5 — the Settings / setup-page Domain card and
// the IT administrator's delegate page. The backend decides; the UI shows status,
// the record, Check now, the delegation controls and the claim messages.

function view(over: Partial<DomainView> = {}): DomainView {
  return {
    status: 'UNVERIFIED',
    allowed_domain: 'acme.example',
    record_name: '_aramo-challenge.acme.example',
    record_value: null,
    verified_at: null,
    token_issued_at: null,
    domain_claim: 'PROVISIONAL',
    domain_claim_conflict: false,
    ...over,
  };
}
const pending = (over: Partial<DomainView> = {}) => view({ status: 'PENDING', record_value: 'aramo-domain-verification=tok', ...over });
const delegation: DomainDelegation = {
  id: 'd1',
  delegate_email: 'it@acme.example',
  expires_at: '2026-10-28T00:00:00Z',
  created_at: '2026-10-21T00:00:00Z',
  last_used_at: null,
  revoked_at: null,
};

function fakeApi(over: Partial<DomainApi> = {}): DomainApi {
  return {
    status: vi.fn(async () => view()),
    request: vi.fn(async () => pending()),
    check: vi.fn(async () => pending()),
    delegations: vi.fn(async () => ({ items: [] as DomainDelegation[] })),
    delegate: vi.fn(async () => delegation),
    revoke: vi.fn(async () => ({ ...delegation, revoked_at: '2026-10-21T01:00:00Z' })),
    ...over,
  };
}

describe('DomainCard', () => {
  it('UNVERIFIED: explains why it matters and offers to get the DNS record', async () => {
    const api = fakeApi();
    render(<DomainCard api={api} />);
    expect(await screen.findByTestId('domain-status')).toHaveTextContent('Unverified');
    expect(screen.getByText(/make your organization the owner of/)).toHaveTextContent(
      'Verify your domain to make your organization the owner of acme.example on Aramo and to start sending with a paid plan.',
    );
    fireEvent.click(screen.getByTestId('domain-request'));
    expect(await screen.findByTestId('domain-record-value')).toHaveTextContent('aramo-domain-verification=tok');
    expect(screen.getByTestId('domain-record-name')).toHaveTextContent('_aramo-challenge.acme.example');
    expect(screen.getByTestId('domain-status')).toHaveTextContent('Pending');
  });

  it('PENDING: Check now with no match keeps it pending and says why', async () => {
    const api = fakeApi({ status: vi.fn(async () => pending()) });
    render(<DomainCard api={api} />);
    fireEvent.click(await screen.findByTestId('domain-check'));
    expect(await screen.findByTestId('domain-notice')).toHaveTextContent(/No matching record yet/);
    expect(api.check).toHaveBeenCalledOnce();
  });

  it('Check now → VERIFIED and AUTHORITATIVE: the owner message, no delegation controls', async () => {
    const api = fakeApi({
      status: vi.fn(async () => pending()),
      check: vi.fn(async () => view({ status: 'VERIFIED', domain_claim: 'AUTHORITATIVE', verified_at: '2026-10-21T00:00:00Z' })),
    });
    render(<DomainCard api={api} />);
    fireEvent.click(await screen.findByTestId('domain-check'));
    expect(await screen.findByTestId('domain-authoritative')).toHaveTextContent('Your organization is the verified owner of acme.example on Aramo');
    expect(screen.getByTestId('domain-status')).toHaveTextContent('Verified');
    expect(screen.queryByTestId('domain-delegation')).toBeNull();
  });

  it('VERIFIED but held by another organization: the conflict message', async () => {
    const api = fakeApi({ status: vi.fn(async () => view({ status: 'VERIFIED', domain_claim: 'LAPSED', domain_claim_conflict: true })) });
    render(<DomainCard api={api} />);
    expect(await screen.findByTestId('domain-conflict')).toHaveTextContent(CONFLICT_MESSAGE);
    expect(CONFLICT_MESSAGE).toBe('Another Aramo organization holds this domain. Contact Aramo support.');
    expect(screen.queryByTestId('domain-check')).toBeNull();
  });

  it('assign to my IT administrator: posts the email, shows "pending — assigned to", and revokes', async () => {
    let items: DomainDelegation[] = [];
    const api = fakeApi({
      status: vi.fn(async () => pending()),
      delegations: vi.fn(async () => ({ items })),
      delegate: vi.fn(async (email: string) => {
        items = [{ ...delegation, delegate_email: email }];
        return items[0] as DomainDelegation;
      }),
    });
    render(<DomainCard api={api} />);
    fireEvent.change(await screen.findByLabelText(/Assign it to your IT administrator/), { target: { value: ' it@acme.example ' } });
    fireEvent.click(screen.getByTestId('domain-delegate'));
    await waitFor(() => expect(api.delegate).toHaveBeenCalledWith('it@acme.example'));
    expect(await screen.findByTestId('domain-delegation-row')).toHaveTextContent('Domain verification pending — assigned to it@acme.example');
    expect(screen.getByTestId('domain-notice')).toHaveTextContent('We emailed it@acme.example');
    fireEvent.click(screen.getByTestId('domain-revoke-d1'));
    await waitFor(() => expect(api.revoke).toHaveBeenCalledWith('d1'));
    await waitFor(() => expect(screen.queryByTestId('domain-delegation-row')).toBeNull());
  });

  it('a non-admin (403) sees a plain explanation', async () => {
    const api = fakeApi({ status: vi.fn(async () => Promise.reject(new ApiError(403, 'no', 'INSUFFICIENT_PERMISSIONS'))) });
    render(<DomainCard api={api} />);
    expect(await screen.findByText('Only an organization owner or admin can verify the domain.')).toBeInTheDocument();
  });

  it('re-issue while verified is explained', async () => {
    const api = fakeApi({
      request: vi.fn(async () => Promise.reject(new ApiError(409, 'x', 'DOMAIN_ALREADY_VERIFIED', { reason: 'already_verified' }))),
    });
    render(<DomainCard api={api} />);
    fireEvent.click(await screen.findByTestId('domain-request'));
    expect(await screen.findByText('This domain is already verified.')).toBeInTheDocument();
  });
});

function dview(over: Partial<DelegateView> = {}): DelegateView {
  return {
    domain: 'acme.example',
    record: { name: '_aramo-challenge.acme.example', value: 'aramo-domain-verification=tok' },
    status: 'PENDING',
    domain_claim_conflict: false,
    ...over,
  };
}

describe('DomainDelegatePage (session-less)', () => {
  it('reads the token from the URL fragment, shows the record, and Check verifies', async () => {
    const api: DelegateApi = {
      view: vi.fn(async () => dview()),
      check: vi.fn(async () => dview({ status: 'VERIFIED' })),
    };
    render(<DomainDelegatePage api={api} hash="#token=abcDEF123_-xyz0000" />);
    expect(await screen.findByTestId('domain-delegate-value')).toHaveTextContent('aramo-domain-verification=tok');
    expect(api.view).toHaveBeenCalledWith('abcDEF123_-xyz0000');
    fireEvent.click(screen.getByTestId('domain-delegate-check'));
    expect(await screen.findByTestId('domain-delegate-verified')).toHaveTextContent('acme.example is verified');
    expect(api.check).toHaveBeenCalledWith('abcDEF123_-xyz0000');
  });

  it('no token, or a rejected link, shows the one invalid-link message', async () => {
    const api: DelegateApi = { view: vi.fn(async () => Promise.reject(new Error('404'))), check: vi.fn() };
    const { unmount } = render(<DomainDelegatePage api={api} hash="" />);
    expect(screen.getByTestId('domain-delegate-invalid')).toBeInTheDocument();
    expect(api.view).not.toHaveBeenCalled();
    unmount();
    render(<DomainDelegatePage api={api} hash="#token=expiredtoken000000" />);
    expect(await screen.findByTestId('domain-delegate-invalid')).toHaveTextContent('This link is invalid or has expired');
  });

  it('verified but held elsewhere: the conflict message', async () => {
    const api: DelegateApi = { view: vi.fn(async () => dview({ status: 'VERIFIED', domain_claim_conflict: true })), check: vi.fn() };
    render(<DomainDelegatePage api={api} hash="#token=abcdefabcdefabcdef" />);
    expect(await screen.findByTestId('domain-delegate-conflict')).toHaveTextContent(CONFLICT_MESSAGE);
  });
});
