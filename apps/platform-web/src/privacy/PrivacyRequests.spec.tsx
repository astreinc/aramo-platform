import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '@aramo/fe-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  platformApi,
  privacyQueueQuery,
  type PrivacyDeletionPreview,
  type PrivacyRequestDetail,
  type PrivacyRequestSummary,
} from '../platform-api';
import { platformSession } from '../skills/test-session';

import { PrivacyRequestDetailView } from './PrivacyRequestDetailView';
import { PrivacyRequestsView } from './PrivacyRequestsView';
import { availableActions, countRows } from './privacy-model';

// PRIV-ADMIN-1 §1.3 / §1.4 — Privacy › Requests: the queue (filters, Failing,
// overdue, execution banner) and the detail (contact hidden until revealed, null
// counts "not verified", the preview path, every action behind a confirm dialog;
// execute needs the typed reference).

const SESSION = platformSession(['platform:tenant:read', 'platform:tenant:lifecycle:manage']);
const ID = '01900000-0000-7000-8000-00000000a001';
const REF = 'PR-AB12-CD34-EF56';

const ROW: PrivacyRequestSummary = {
  id: ID,
  reference: REF,
  request_type: 'DELETION',
  subject_kind: 'ACCOUNT_HOLDER',
  channel: 'WEB',
  status: 'DATA_INVENTORY',
  status_label: 'Being reviewed by the Aramo privacy team',
  referred_to_organization: false,
  due_at: '2020-01-01T00:00:00Z',
  created_at: '2019-12-02T00:00:00Z',
  updated_at: '2019-12-03T00:00:00Z',
  completed_at: null,
  outcome_code: null,
  outcome_text: null,
  product: 'SIGN',
  subject_user_id: 'u-subject',
  subject_tenant_id: 't-subject',
  referred_tenant_id: null,
  assigned_operator_id: SESSION.sub,
  overdue: true,
  inventory: null,
  completion_evidence: null,
  failing: 2,
};

function detail(over: Partial<PrivacyRequestDetail> = {}): PrivacyRequestDetail {
  return {
    ...ROW,
    assigned_operator_id: null,
    due_at: '2999-01-01T00:00:00Z',
    inventory: {
      native_sessions_active: null,
      refresh_tokens_active: 3,
      saved_signatures: 0,
      account_found: true,
    },
    completion_evidence: null,
    contact_present: true,
    attempts: 0,
    events: [
      {
        id: 'ev-1',
        event_type: 'CREATED',
        from_status: null,
        to_status: 'RECEIVED',
        actor_type: 'SUBJECT',
        actor_id: null,
        payload: {},
        created_at: '2019-12-02T00:00:00Z',
      },
      {
        id: 'ev-2',
        event_type: 'STATUS_CHANGED',
        from_status: 'IDENTITY_VALIDATED',
        to_status: 'DATA_INVENTORY',
        actor_type: 'OPERATOR',
        actor_id: 'op-1',
        payload: { note: 'counts taken' },
        created_at: '2019-12-03T00:00:00Z',
      },
    ],
    execution_enabled: true,
    ...over,
  };
}

const PREVIEW: PrivacyDeletionPreview = {
  path: 'personal_full',
  reasons: [],
  dependencies: ['unknown'],
};

afterEach(() => vi.restoreAllMocks());

function renderQueue() {
  render(
    <MemoryRouter>
      <PrivacyRequestsView session={SESSION} />
    </MemoryRouter>,
  );
}

function renderDetail() {
  render(
    <MemoryRouter initialEntries={[`/privacy-requests/${ID}`]}>
      <Routes>
        <Route
          path="/privacy-requests/:id"
          element={<PrivacyRequestDetailView session={SESSION} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

/** Every write the detail can make, spied (none must fire before a confirm). */
function spyWrites() {
  const summary = Promise.resolve(ROW);
  return {
    assign: vi.spyOn(platformApi, 'assignPrivacyRequest').mockReturnValue(summary),
    validate: vi.spyOn(platformApi, 'validatePrivacyRequest').mockReturnValue(summary),
    inventory: vi.spyOn(platformApi, 'inventoryPrivacyRequest').mockReturnValue(summary),
    refer: vi.spyOn(platformApi, 'referPrivacyRequest').mockReturnValue(summary),
    execute: vi.spyOn(platformApi, 'executePrivacyRequest').mockReturnValue(summary),
    complete: vi.spyOn(platformApi, 'completePrivacyRequest').mockReturnValue(summary),
    deny: vi.spyOn(platformApi, 'denyPrivacyRequest').mockReturnValue(summary),
    cancel: vi.spyOn(platformApi, 'cancelPrivacyRequest').mockReturnValue(summary),
    note: vi.spyOn(platformApi, 'addPrivacyNote').mockResolvedValue({}),
    returnToQueue: vi.spyOn(platformApi, 'returnPrivacyRequestToQueue').mockReturnValue(summary),
    reveal: vi
      .spyOn(platformApi, 'revealPrivacyContact')
      .mockResolvedValue({ contact_email: 'raju@example.com' }),
  };
}

type Writes = ReturnType<typeof spyWrites>;

function noWrites(w: Writes): void {
  for (const spy of Object.values(w)) expect(spy).not.toHaveBeenCalled();
}

describe('privacyQueueQuery', () => {
  it('sends only the filters that are set, per §1.1', () => {
    expect(privacyQueueQuery()).toBe('');
    expect(
      privacyQueueQuery({
        status: 'EXECUTING',
        request_type: 'DELETION',
        include_closed: true,
        limit: 500,
        channel: 'WEB',
        subject_kind: 'BUSINESS_MEMBER',
        assigned: 'me',
        overdue: true,
        reference: '  pr-ab12-cd34-ef56 ',
      }),
    ).toBe(
      '?status=EXECUTING&request_type=DELETION&include_closed=true&limit=500&channel=WEB&subject_kind=BUSINESS_MEMBER&assigned=me&overdue=true&reference=pr-ab12-cd34-ef56',
    );
  });
});

describe('PrivacyRequestsView (queue)', () => {
  it('lists requests with type, subject, channel, status, overdue, operator, Failing and the execution banner', async () => {
    const list = vi
      .spyOn(platformApi, 'listPrivacyRequests')
      .mockResolvedValue({ items: [ROW], execution_enabled: false });
    renderQueue();
    const row = await screen.findByTestId(`privacy-row-${ID}`);
    expect(list).toHaveBeenCalledWith({ limit: 200 });
    expect(within(row).getByText(REF)).toBeInTheDocument();
    expect(within(row).getByText('Deletion')).toBeInTheDocument();
    expect(within(row).getByText('Account holder')).toBeInTheDocument();
    expect(within(row).getByText('Web')).toBeInTheDocument();
    expect(within(row).getByText('In review')).toBeInTheDocument();
    expect(within(row).getByText('Being reviewed by the Aramo privacy team')).toBeInTheDocument();
    expect(within(row).getByText('Overdue')).toBeInTheDocument();
    expect(within(row).getByText('Failing')).toBeInTheDocument();
    expect(within(row).getByText('You')).toBeInTheDocument();
    expect(screen.getByTestId('privacy-execution-banner')).toHaveTextContent(
      'Deletion execution is off.',
    );
    // the contact email is never on the queue
    expect(screen.queryByText(/@/)).toBeNull();
  });

  it('shows no Failing badge without failures and the "on" banner when execution is enabled', async () => {
    vi.spyOn(platformApi, 'listPrivacyRequests').mockResolvedValue({
      items: [{ ...ROW, failing: 0, due_at: '2999-01-01T00:00:00Z' }],
      execution_enabled: true,
    });
    renderQueue();
    const row = await screen.findByTestId(`privacy-row-${ID}`);
    expect(within(row).queryByText('Failing')).toBeNull();
    expect(within(row).queryByText('Overdue')).toBeNull();
    expect(screen.getByTestId('privacy-execution-banner')).toHaveTextContent(
      'Deletion execution is on.',
    );
  });

  it('applies the §1.1 filters', async () => {
    const list = vi
      .spyOn(platformApi, 'listPrivacyRequests')
      .mockResolvedValue({ items: [], execution_enabled: false });
    renderQueue();
    expect(await screen.findByText('No requests match these filters')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'ACCESS' } });
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({ limit: 200, request_type: 'ACCESS' }),
    );
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'EXECUTING' } });
    fireEvent.change(screen.getByLabelText('Subject kind'), {
      target: { value: 'BUSINESS_MEMBER' },
    });
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'IN_APP' } });
    fireEvent.change(screen.getByLabelText('Show at most'), { target: { value: '500' } });
    fireEvent.click(screen.getByLabelText('Assigned to me'));
    fireEvent.click(screen.getByLabelText('Overdue'));
    fireEvent.click(screen.getByLabelText('Include closed'));
    fireEvent.change(screen.getByLabelText('Reference'), {
      target: { value: ' pr-ab12-cd34-ef56 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({
        limit: 500,
        request_type: 'ACCESS',
        status: 'EXECUTING',
        subject_kind: 'BUSINESS_MEMBER',
        channel: 'IN_APP',
        assigned: 'me',
        overdue: true,
        include_closed: true,
        reference: 'pr-ab12-cd34-ef56',
      }),
    );
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: '' } });
    await waitFor(() => expect(list.mock.lastCall?.[0]).not.toHaveProperty('request_type'));
  });
});

describe('PrivacyRequestDetailView', () => {
  it('renders the facts, inventory (null = not verified), evidence, preview and history; contact hidden', async () => {
    vi.spyOn(platformApi, 'getPrivacyRequest').mockResolvedValue(
      detail({
        status: 'COMPLETED',
        completed_at: '2019-12-04T00:00:00Z',
        outcome_code: 'personal_account_deleted',
        completion_evidence: { sessions_revoked: null, drafts_deleted: 0 },
      }),
    );
    const preview = vi.spyOn(platformApi, 'getPrivacyPreview').mockResolvedValue(PREVIEW);
    const w = spyWrites();
    renderDetail();
    expect(await screen.findByRole('heading', { name: REF })).toBeInTheDocument();
    expect(screen.getByText('Hidden')).toBeInTheDocument();
    expect(screen.queryByText('raju@example.com')).toBeNull();
    const inv = screen.getByTestId('privacy-inventory');
    expect(inv).toHaveTextContent('counts at inventory time');
    expect(within(inv).getByTestId('count-native_sessions_active')).toHaveTextContent(
      'not verified',
    );
    expect(within(inv).getByTestId('count-refresh_tokens_active')).toHaveTextContent('3');
    expect(within(inv).getByTestId('count-saved_signatures')).toHaveTextContent('0');
    const ev = screen.getByTestId('privacy-evidence');
    expect(within(ev).getByTestId('count-sessions_revoked')).toHaveTextContent('not verified');
    expect(within(ev).getByTestId('count-sessions_revoked')).not.toHaveTextContent('0');
    expect(within(ev).getByTestId('count-drafts_deleted')).toHaveTextContent('0');
    expect(screen.getByText('personal_account_deleted')).toBeInTheDocument();
    const history = screen.getByTestId('privacy-history');
    expect(within(history).getByText('Request received', { selector: 'b' })).toBeInTheDocument();
    expect(within(history).getByText('counts taken')).toBeInTheDocument();
    // a closed request: no preview, no lifecycle actions (Add note only)
    expect(preview).not.toHaveBeenCalled();
    expect(screen.queryByTestId('privacy-preview')).toBeNull();
    const actions = within(screen.getByRole('group', { name: 'Actions' }))
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(actions).toEqual(['Add note…']);
    noWrites(w);
  });

  it('reveals the contact only after the confirm dialog', async () => {
    vi.spyOn(platformApi, 'getPrivacyRequest').mockResolvedValue(detail());
    vi.spyOn(platformApi, 'getPrivacyPreview').mockResolvedValue(PREVIEW);
    const w = spyWrites();
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal contact…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reveal contact' });
    expect(dialog).toHaveTextContent('recorded in the history');
    noWrites(w);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reveal contact' }));
    await waitFor(() => expect(w.reveal).toHaveBeenCalledWith(ID));
    expect(await screen.findByTestId('privacy-contact')).toHaveTextContent('raju@example.com');
  });

  it('says "None on file" when there is no contact', async () => {
    vi.spyOn(platformApi, 'getPrivacyRequest').mockResolvedValue(
      detail({ contact_present: false }),
    );
    vi.spyOn(platformApi, 'getPrivacyPreview').mockResolvedValue(PREVIEW);
    renderDetail();
    expect(await screen.findByText('None on file')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reveal contact…' })).toBeNull();
  });

  it('execute deletion: danger, names the preview path, needs a note and the typed reference', async () => {
    vi.spyOn(platformApi, 'getPrivacyRequest').mockResolvedValue(detail());
    vi.spyOn(platformApi, 'getPrivacyPreview').mockResolvedValue(PREVIEW);
    const w = spyWrites();
    renderDetail();
    expect(await screen.findByTestId('privacy-preview-path')).toHaveTextContent('personal_full');
    expect(screen.getByTestId('privacy-preview')).toHaveTextContent('unknown (not verified)');
    fireEvent.click(screen.getByRole('button', { name: 'Execute deletion…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Execute deletion' });
    expect(within(dialog).getByTestId('execute-path')).toHaveTextContent(
      'Personal account, full deletion',
    );
    expect(dialog).toHaveTextContent('can’t be undone');
    const commit = within(dialog).getByRole('button', { name: 'Execute deletion' });
    expect(commit.className).toContain('pw-btn--danger');
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Note'), { target: { value: 'checked' } });
    expect(commit).toBeDisabled();
    const typed = within(dialog).getByLabelText(`Type the reference ${REF} to confirm`);
    fireEvent.change(typed, { target: { value: 'PR-AB12-CD34-EF57' } });
    expect(commit).toBeDisabled();
    fireEvent.click(commit);
    noWrites(w);
    fireEvent.change(typed, { target: { value: REF } });
    expect(commit).toBeEnabled();
    fireEvent.click(commit);
    await waitFor(() => expect(w.execute).toHaveBeenCalledWith(ID, { note: 'checked' }));
  });

  it('execute stays disabled when the preview says not executable', async () => {
    vi.spyOn(platformApi, 'getPrivacyRequest').mockResolvedValue(detail());
    vi.spyOn(platformApi, 'getPrivacyPreview').mockResolvedValue({
      path: 'not_executable',
      reasons: ['legal_hold'],
      dependencies: [],
    });
    const w = spyWrites();
    renderDetail();
    expect(await screen.findByText('legal_hold')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Execute deletion…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Execute deletion' });
    fireEvent.change(within(dialog).getByLabelText('Note'), { target: { value: 'x' } });
    fireEvent.change(within(dialog).getByLabelText(`Type the reference ${REF} to confirm`), {
      target: { value: REF },
    });
    expect(within(dialog).getByRole('button', { name: 'Execute deletion' })).toBeDisabled();
    noWrites(w);
  });

  it('no Execute deletion while execution is off', async () => {
    vi.spyOn(platformApi, 'getPrivacyRequest').mockResolvedValue(
      detail({ execution_enabled: false }),
    );
    vi.spyOn(platformApi, 'getPrivacyPreview').mockResolvedValue(PREVIEW);
    renderDetail();
    await screen.findByRole('heading', { name: REF });
    expect(screen.queryByRole('button', { name: 'Execute deletion…' })).toBeNull();
    expect(screen.getByTestId('privacy-execution-banner')).toHaveTextContent(
      'Deletion execution is off.',
    );
  });

  // [button, dialog title, commit, detail overrides, note label | null, spy, expected args]
  const CASES: ReadonlyArray<
    readonly [
      string,
      string,
      string,
      Partial<PrivacyRequestDetail>,
      string | null,
      keyof Writes,
      readonly unknown[],
    ]
  > = [
    ['Assign to me', 'Assign to me', 'Assign to me', {}, null, 'assign', [ID]],
    [
      'Record identity check…',
      'Record identity check',
      'Record identity check',
      { status: 'RECEIVED' },
      'How identity was checked',
      'validate',
      [ID, { note: 'n' }],
    ],
    [
      'Take inventory…',
      'Take inventory',
      'Take inventory',
      { status: 'IDENTITY_VALIDATED' },
      null,
      'inventory',
      [ID],
    ],
    [
      'Refer to organization…',
      'Refer to organization',
      'Refer',
      {},
      'Note',
      'refer',
      [ID, { note: 'n' }],
    ],
    [
      'Record outcome…',
      'Record outcome',
      'Record outcome',
      { request_type: 'ACCESS' },
      'Outcome note (shown to the requester)',
      'complete',
      [ID, { note: 'n' }],
    ],
    [
      'Deny…',
      'Deny request',
      'Deny request',
      {},
      'Reason (shown to the requester)',
      'deny',
      [ID, { note: 'n' }],
    ],
    [
      'Cancel request…',
      'Cancel request',
      'Cancel request',
      {},
      'Reason (shown to the requester)',
      'cancel',
      [ID, { note: 'n' }],
    ],
    ['Add note…', 'Add note', 'Add note', {}, 'Note', 'note', [ID, { note: 'n' }]],
    [
      'Return to queue…',
      'Return to queue',
      'Return to queue',
      { status: 'EXECUTING', attempts: 1 },
      'Note',
      'returnToQueue',
      [ID, { note: 'n' }],
    ],
  ];

  it.each(CASES)(
    '%s calls its client function only after confirmation',
    async (button, title, commitName, over, noteLabel, spy, args) => {
      vi.spyOn(platformApi, 'getPrivacyRequest').mockResolvedValue(detail(over));
      vi.spyOn(platformApi, 'getPrivacyPreview').mockResolvedValue(PREVIEW);
      const w = spyWrites();
      renderDetail();
      fireEvent.click(await screen.findByRole('button', { name: button }));
      const dialog = await screen.findByRole('dialog', { name: title });
      const commit = within(dialog).getByRole('button', { name: commitName });
      noWrites(w);
      if (noteLabel !== null) {
        expect(commit).toBeDisabled();
        fireEvent.change(within(dialog).getByLabelText(noteLabel), { target: { value: ' n ' } });
      }
      fireEvent.click(commit);
      await waitFor(() => expect(w[spy]).toHaveBeenCalledWith(...args));
      for (const [k, s] of Object.entries(w)) if (k !== spy) expect(s).not.toHaveBeenCalled();
    },
  );

  it('closing a dialog writes nothing', async () => {
    vi.spyOn(platformApi, 'getPrivacyRequest').mockResolvedValue(detail());
    vi.spyOn(platformApi, 'getPrivacyPreview').mockResolvedValue(PREVIEW);
    const w = spyWrites();
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Deny…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deny request' });
    fireEvent.change(within(dialog).getByLabelText('Reason (shown to the requester)'), {
      target: { value: 'no' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Go back' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    noWrites(w);
  });

  it('Record outcome warns the note is shown to the requester; refer shows the organization', async () => {
    vi.spyOn(platformApi, 'getPrivacyRequest').mockResolvedValue(
      detail({ request_type: 'EXPORT' }),
    );
    spyWrites();
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Record outcome…' }));
    expect(await screen.findByRole('dialog', { name: 'Record outcome' })).toHaveTextContent(
      'shown to the requester',
    );
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Go back' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Refer to organization…' }));
    expect(await screen.findByRole('dialog', { name: 'Refer to organization' })).toHaveTextContent(
      't-subject',
    );
  });

  it('shows a refusal with its reason code (privacy_referral_tenant_mismatch)', async () => {
    vi.spyOn(platformApi, 'getPrivacyRequest').mockResolvedValue(detail());
    vi.spyOn(platformApi, 'getPrivacyPreview').mockResolvedValue(PREVIEW);
    vi.spyOn(platformApi, 'referPrivacyRequest').mockRejectedValue(
      new ApiError(409, 'refused', 'IDEMPOTENCY_KEY_CONFLICT', {
        reason: 'privacy_referral_tenant_mismatch',
      }),
    );
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Refer to organization…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Refer to organization' });
    fireEvent.change(within(dialog).getByLabelText('Note'), { target: { value: 'n' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Refer' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'privacy_referral_tenant_mismatch',
    );
  });

  it('Failing: shows the attempt count and last error, offers Return to queue', async () => {
    vi.spyOn(platformApi, 'getPrivacyRequest').mockResolvedValue(
      detail({
        status: 'EXECUTING',
        attempts: 2,
        events: [
          {
            id: 'ev-f',
            event_type: 'EXECUTION_FAILED',
            from_status: 'EXECUTING',
            to_status: 'EXECUTING',
            actor_type: 'SYSTEM',
            actor_id: null,
            payload: { error: 'CognitoUnavailable' },
            created_at: '2019-12-05T00:00:00Z',
          },
        ],
      }),
    );
    vi.spyOn(platformApi, 'getPrivacyPreview').mockResolvedValue(PREVIEW);
    renderDetail();
    expect(await screen.findByTestId('privacy-failing')).toHaveTextContent(
      'Execution failed 2 times',
    );
    expect(screen.getByTestId('privacy-failing')).toHaveTextContent('CognitoUnavailable');
    expect(screen.getAllByText('Failing').length).toBeGreaterThanOrEqual(1);
    const actions = within(screen.getByRole('group', { name: 'Actions' }))
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(actions).toEqual(['Assign to me', 'Return to queue…', 'Add note…']);
  });
});

describe('availableActions', () => {
  const base = detail();
  it('never offers Record outcome for a DELETION (OD-1); Return to queue only in EXECUTING', () => {
    for (const status of [
      'RECEIVED',
      'IDENTITY_VALIDATED',
      'DATA_INVENTORY',
      'REFERRED_TO_ORGANIZATION',
      'EXECUTING',
    ] as const) {
      const a = availableActions({ ...base, status }, null);
      expect(a).not.toContain('complete');
      expect(a.includes('returnToQueue')).toBe(status === 'EXECUTING');
    }
    expect(
      availableActions(
        { ...base, request_type: 'CORRECTION', status: 'REFERRED_TO_ORGANIZATION' },
        null,
      ),
    ).toContain('complete');
    expect(
      availableActions({ ...base, request_type: 'ACCESS', status: 'RECEIVED' }, null),
    ).not.toContain('complete');
  });

  it('hides Assign to me when the request is already mine', () => {
    expect(availableActions({ ...base, assigned_operator_id: 'me' }, 'me')).not.toContain('assign');
  });
});

describe('countRows', () => {
  it('renders null as "not verified", never 0, and flattens nested counts', () => {
    expect(countRows({ a: null, b: 0, c: { d: null, e: 2 } })).toEqual([
      { key: 'a', label: 'A', value: 'not verified', notVerified: true },
      { key: 'b', label: 'B', value: '0', notVerified: false },
      { key: 'c.d', label: 'C d', value: 'not verified', notVerified: true },
      { key: 'c.e', label: 'C e', value: '2', notVerified: false },
    ]);
  });
});
