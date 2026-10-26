import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError, configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@aramo/fe-foundation';

import { App } from '../App';
import { platformSession } from '../skills/test-session';

import { AuditExplorerView } from './AuditExplorerView';
import { CommercialRolesSection } from './CommercialRolesSection';
import {
  governanceApi,
  type AuditEvent,
  type PolicyList,
  type PolicyVersion,
  type Roster,
  type RosterOperator,
} from './governance-api';
import { governanceErrorText } from './governance-errors';
import {
  POLICY_FIELDS,
  activationDiff,
  chainLine,
  chainWhy,
  eventDetail,
  eventLabel,
  planRoleChange,
  policyRows,
} from './governance-model';
import { PolicyView } from './PolicyView';

// CCP-B5 (PBD §5.3 row B5; handoff §5.6–§5.8) — the governance screens: the model, the
// Policy screen (activation is a change request), the Audit explorer (export through the
// read-only server export), Platform admins › commercial roles (governed role-change
// requests only, last-owner refusal surfaced), and per-role visibility of the routes for the
// 6 commercial roles and super_admin.

const sess = (scopes: string[], sub: string): Session => ({ ...platformSession(scopes), sub });
const V1 = '019a0000-0000-7000-8000-0000000cc201';
const V2 = '019a0000-0000-7000-8000-0000000cc2a2';
const CONTENT = {
  format_version: 1,
  currency: 'USD',
  discount_escalation_threshold_bps: 2000,
  credit_escalation_threshold_minor: 50_000,
  support_extension_max_days: 14,
  support_extension_frequency_window_days: 90,
  support_extension_cumulative_max_days: 30,
  support_extension_cumulative_window_days: 365,
  approval_expiry_hours: 72,
  past_due_grace_days: 7,
};
const version = (o: Partial<PolicyVersion>): PolicyVersion => ({
  id: V1,
  version_number: 1,
  status: 'ACTIVE',
  content: CONTENT,
  content_checksum: 'a'.repeat(64),
  note: 'First governed commercial policy.',
  created_by: 'u-daniel',
  created_at: '2026-10-20T10:00:00.000Z',
  activated_by: 'u-daniel',
  activated_at: '2026-10-23T10:00:00.000Z',
  retired_at: null,
  open_request: null,
  latest_request: null,
  ...o,
});
const ACTIVE = version({});
const DRAFT = version({
  id: V2,
  version_number: 2,
  status: 'DRAFT',
  content: { ...CONTENT, credit_escalation_threshold_minor: 30_000, approval_expiry_hours: 48 },
  content_checksum: 'b'.repeat(64),
  note: 'Tighten after Q3.',
  created_by: 'u-priya',
  activated_by: null,
  activated_at: null,
});
const list = (caller: PolicyList['caller'], extra: Partial<PolicyList> = {}): PolicyList => ({
  versions: [DRAFT, ACTIVE],
  active_version_id: V1,
  open_request: null,
  caller,
  ...extra,
});

const op = (o: Partial<RosterOperator> & { user_id: string }): RosterOperator => ({
  email: `${o.user_id}@aramo.ai`,
  display_name: null,
  role_keys: [],
  commercial_role_keys: [],
  attested: true,
  is_last_owner: false,
  pending_role_requests: [],
  ...o,
});
const CHAINS: Roster['chains'] = [
  {
    key: 'ABOVE_THRESHOLD',
    rule: 'FINANCE_THEN_OWNER',
    maker_roles: ['commercial_ops'],
    step_roles: ['finance_admin', 'platform_owner'],
    fulfillable: true,
    missing: null,
    unfillable_steps: [],
  },
  {
    key: 'ROLE_CHANGE',
    rule: 'DISTINCT_PLATFORM_OWNER',
    maker_roles: ['platform_owner'],
    step_roles: ['platform_owner'],
    fulfillable: false,
    missing: 'steps',
    unfillable_steps: [0],
  },
];
const roster = (operators: RosterOperator[]): Roster => ({
  operators,
  chains: CHAINS,
  all_fulfillable: false,
});

describe('CCP-B5 governance model', () => {
  it('B5-W-1 the policy table formats in UI units and marks the changed settings; the threshold help follows the at-or-above ruling (A2-B)', () => {
    const rows = policyRows(DRAFT, ACTIVE);
    expect(rows.map((r) => [r.field.label, r.active, r.mine, r.changed])).toEqual([
      ['Discount approval threshold', '20%', '20%', false],
      ['Credit approval threshold', '$500', '$300', true],
      ['Support extension, per use', '14 days', '14 days', false],
      [
        'Support extension frequency',
        'once per tenant per 90 days',
        'once per tenant per 90 days',
        false,
      ],
      ['Support extension, cumulative cap', '30 days', '30 days', false],
      ['Approval window (TTL)', '72 h', '48 h', true],
      ['Past-due grace', '7 days', '7 days', false],
    ]);
    expect(POLICY_FIELDS[0]?.help).toBe(
      'Discounts at or above this need Finance → Owner; below, Finance only.',
    );
    expect(activationDiff(DRAFT, ACTIVE)).toEqual([
      ['Credit approval threshold', '$500', '$300'],
      ['Approval window (TTL)', '72 h', '48 h'],
    ]);
    expect(activationDiff(version({ id: V2, version_number: 2, status: 'DRAFT' }), ACTIVE)).toEqual(
      [['All settings', 'Same as v1', 'No change']],
    );
  });

  it('FIX1-W-1 the optional apply deadline (Charter Amendment A1 AD-1): no row while neither version declares it; listed as "Not set" in the draft editor; shown and diffed once a version declares it', () => {
    expect(policyRows(DRAFT, ACTIVE).map((r) => r.field.key)).not.toContain('apply_expiry_hours');
    const editor = policyRows(DRAFT, ACTIVE, { includeOptional: true });
    expect(editor.at(-1)).toMatchObject({ active: 'Not set', mine: 'Not set', declared: false, changed: false });
    expect(editor.at(-1)?.field).toMatchObject({ key: 'apply_expiry_hours', label: 'Apply deadline (TTL)', min: 1, max: 87_600, optional: true });
    const v2 = version({ id: V2, version_number: 2, status: 'DRAFT', content: { ...CONTENT, apply_expiry_hours: 72 } });
    expect(policyRows(v2, ACTIVE).at(-1)).toMatchObject({ active: 'Not set', mine: '72 h', raw: 72, declared: true, changed: true });
    expect(activationDiff(v2, ACTIVE)).toEqual([['Apply deadline (TTL)', 'Not set', '72 h']]);
  });

  it('B5-W-2 a role change is one request per toggled role; removing Platform owner from the last owner is refused', () => {
    const last = op({
      user_id: 'u-arjun',
      commercial_role_keys: ['finance_admin', 'platform_owner'],
      is_last_owner: true,
    });
    expect(planRoleChange(last, 'Arjun Rao', ['finance_admin'])).toEqual({
      grants: [],
      revokes: ['platform_owner'],
      refusal:
        'Refused: Arjun Rao is the last Platform owner. Grant Platform owner to another person first, then remove it here.',
    });
    expect(
      planRoleChange(last, 'Arjun Rao', ['finance_admin', 'platform_owner', 'read_only_auditor']),
    ).toEqual({ grants: ['read_only_auditor'], revokes: [], refusal: null });
    expect(planRoleChange({ ...last, is_last_owner: false }, 'Arjun Rao', []).refusal).toBeNull();
  });

  it('B5-W-3 audit labels and details read the structured events; chain lines name makers and steps', () => {
    expect(eventLabel('COMMERCIAL_AUDIT_EXPORTED')).toBe('Audit exported');
    expect(eventLabel('COMMERCIAL_SOMETHING_NEW')).toBe('Something new');
    const names = (id: string) => (id === 'u-ines' ? 'Ines Duarte' : id);
    expect(
      eventDetail(
        { event_type: 'COMMERCIAL_APPROVAL_RECORDED', payload: { step_role_key: 'finance_admin' } },
        names,
      ),
    ).toBe('Finance step signed');
    expect(
      eventDetail(
        {
          event_type: 'COMMERCIAL_CHANGE_REQUEST_APPLIED',
          payload: { change: 'GRANT', subject_user_id: 'u-ines', role_key: 'finance_admin' },
        },
        names,
      ),
    ).toBe('Granted Finance admin to Ines Duarte');
    expect(
      eventDetail(
        {
          event_type: 'COMMERCIAL_CHANGE_REQUEST_APPLIED',
          payload: { change: 'POLICY_ACTIVATE', to_version_number: 2, from_version_number: 1 },
        },
        names,
      ),
    ).toBe('Policy v2 activated; v1 retired');
    expect(
      eventDetail({ event_type: 'COMMERCIAL_AUDIT_EXPORTED', payload: { row_count: 8 } }, names),
    ).toBe('8 events exported as CSV');
    expect(chainLine(CHAINS[0]!)).toBe('Maker: Commercial ops → Finance → Owner');
    expect(chainWhy(CHAINS[1]!)).toBe('Needs more distinct people with Platform owner.');
    expect(
      governanceErrorText(
        new ApiError(409, 'x', 'PLATFORM_LAST_OWNER', { reason: 'platform_last_owner' }),
      ),
    ).toContain('last Platform owner');
  });
});

describe('CCP-B5 PolicyView (handoff §5.6)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('B5-W-4 finance_admin: the draft is editable inline (saved through PATCH) and "Request activation…" opens the change-request dialog; it submits a POLICY_ACTIVATE with the target snapshot, never an activation', async () => {
    vi.spyOn(governanceApi, 'listPolicyVersions').mockResolvedValue(
      list({ can_author: true, can_request_activation: true }),
    );
    vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(
      roster([
        op({
          user_id: 'u-priya',
          display_name: 'Priya Shah',
          commercial_role_keys: ['finance_admin'],
        }),
      ]),
    );
    const update = vi
      .spyOn(governanceApi, 'updatePolicyDraft')
      .mockResolvedValue({
        version: { ...DRAFT, content: { ...DRAFT.content!, past_due_grace_days: 10 } },
      });
    const request = vi
      .spyOn(governanceApi, 'requestChange')
      .mockResolvedValue({
        id: '019a0000-0000-7000-8000-00000000c0de',
        action_type: 'POLICY_ACTIVATE',
        state: 'PENDING_APPROVAL',
        policy_version_id: V1,
        required_chain: { rule: 'FINANCE_THEN_OWNER', steps: [] },
      });
    render(<PolicyView />);
    expect(await screen.findByRole('heading', { name: 'Policy v2' })).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByText('Created 20 Oct 2026 by Priya Shah')).toBeInTheDocument();
    expect(screen.getByText('2 setting(s) differ from v1')).toBeInTheDocument();
    const grace = screen.getByLabelText('Past-due grace');
    fireEvent.change(grace, { target: { value: '10' } });
    fireEvent.blur(grace);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(V2, { content: { past_due_grace_days: 10 } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Request activation…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request activation · policy v2' });
    expect(within(dialog).getByTestId('chain-preview')).toHaveTextContent(
      'Approval chainPolicy changeFinance → Ownerpolicy v1 · 72 h window',
    );
    const commit = within(dialog).getByRole('button', { name: 'Submit for approval' });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Q3 review' } });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Evidence'), {
      target: { value: 'FIN-2026-Q3' },
    });
    fireEvent.click(commit);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const [body] = request.mock.calls[0]!;
    expect(body).toMatchObject({
      action_type: 'POLICY_ACTIVATE',
      payload: {
        policy_version_id: V2,
        target_content_checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      reason: 'Q3 review\n\nEvidence: FIN-2026-Q3',
    });
  });

  it('FIX1-W-2 the draft editor sets the optional apply deadline through PATCH; left blank it stays unset (nothing sent)', async () => {
    vi.spyOn(governanceApi, 'listPolicyVersions').mockResolvedValue(
      list({ can_author: true, can_request_activation: true }),
    );
    vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(roster([]));
    const update = vi
      .spyOn(governanceApi, 'updatePolicyDraft')
      .mockResolvedValue({ version: { ...DRAFT, content: { ...DRAFT.content!, apply_expiry_hours: 72 } } });
    render(<PolicyView />);
    const ttl = await screen.findByLabelText('Apply deadline (TTL)');
    expect(ttl).toHaveValue(null);
    expect(ttl).toHaveAttribute('placeholder', 'Not set');
    fireEvent.blur(ttl);
    expect(update).not.toHaveBeenCalled();
    fireEvent.change(ttl, { target: { value: '72' } });
    fireEvent.blur(ttl);
    await waitFor(() => expect(update).toHaveBeenCalledWith(V2, { content: { apply_expiry_hours: 72 } }));
  });

  it('B5-W-5 platform_owner can draft but not request activation (TD-A3-5): the button is disabled with the reason; read_only_auditor sees the view-only note and no inputs', async () => {
    vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(roster([]));
    const lv = vi
      .spyOn(governanceApi, 'listPolicyVersions')
      .mockResolvedValue(list({ can_author: true, can_request_activation: false }));
    const { unmount } = render(<PolicyView />);
    const btn = await screen.findByRole('button', { name: 'Request activation…' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Needs the Finance admin role.');
    // CCP-FIX1: 7 design settings + the optional apply deadline in the draft editor.
    expect(screen.getAllByRole('spinbutton')).toHaveLength(8);
    unmount();
    lv.mockResolvedValue(list({ can_author: false, can_request_activation: false }));
    render(<PolicyView />);
    expect(await screen.findByRole('note')).toHaveTextContent(
      'View only. You can view policy versions. Drafting and requesting activation needs the Platform owner or Finance admin role.',
    );
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Request activation…' })).toBeDisabled();
  });

  it('B5-W-6 an open activation request locks the draft and names the request; the active version offers no action while a draft exists', async () => {
    vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(roster([]));
    vi.spyOn(governanceApi, 'listPolicyVersions').mockResolvedValue(
      list(
        { can_author: true, can_request_activation: true },
        {
          versions: [
            {
              ...DRAFT,
              open_request: {
                id: '019a0000-0000-7000-8000-0000000000aa',
                state: 'PENDING_APPROVAL',
                apply_actionable: false,
              },
            },
            ACTIVE,
          ],
          open_request: {
            id: '019a0000-0000-7000-8000-0000000000aa',
            state: 'PENDING_APPROVAL',
            policy_version_id: V2,
          },
        },
      ),
    );
    render(<PolicyView />);
    expect(
      await screen.findByText('Open request CR-019A0000 · pending approval'),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Request activation…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^v1/ }));
    expect(screen.getByText('This is the active version')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create draft/ })).toBeNull();
    // CCP-B5-R: a pending request is not applyable (apply_actionable false → no Apply button).
    expect(screen.queryByRole('button', { name: /Apply activation|Retry apply/ })).toBeNull();
  });

  // ---- CCP-B5-R (TD-B5-1; Charter Amendment A1) ----------------------------------------------
  const CR_ID = '019a0000-0000-7000-8000-0000000000bb';
  const withOpen = (state: string, apply_actionable: boolean, withdraw_actionable = false): PolicyList =>
    list(
      { can_author: true, can_request_activation: true },
      {
        versions: [{ ...DRAFT, open_request: { id: CR_ID, state, apply_actionable, withdraw_actionable } }, ACTIVE],
        open_request: { id: CR_ID, state, policy_version_id: V2 },
      },
    );

  it('B5R-W-1 the Apply button follows apply_actionable: shown for the requester of an APPROVED request (POST …/apply, then reload); hidden for an approver of the same request', async () => {
    vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(roster([]));
    const listSpy = vi.spyOn(governanceApi, 'listPolicyVersions').mockResolvedValueOnce(withOpen('APPROVED', true)).mockResolvedValue(
      list(
        { can_author: true, can_request_activation: true },
        { versions: [{ ...DRAFT, status: 'ACTIVE', latest_request: { id: CR_ID, state: 'APPLIED', applied_at: '2026-10-25T10:00:00.000Z' } }, { ...ACTIVE, status: 'RETIRED' }] },
      ),
    );
    const apply = vi.spyOn(governanceApi, 'applyChange').mockResolvedValue({ request: { id: CR_ID, state: 'APPLIED', applied_at: '2026-10-25T10:00:00.000Z' } });
    render(<PolicyView />);
    expect(await screen.findByText('Open request CR-019A0000 · approved')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply activation' }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith(CR_ID));
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Request CR-019A0000 · applied /)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply activation|Retry apply/ })).toBeNull();
  });

  it('B5R-W-2 an approver (apply_actionable false) sees the approved request but no Apply button', async () => {
    vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(roster([]));
    vi.spyOn(governanceApi, 'listPolicyVersions').mockResolvedValue(withOpen('APPROVED', false));
    render(<PolicyView />);
    expect(await screen.findByText('Open request CR-019A0000 · approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply activation|Retry apply/ })).toBeNull();
  });

  it('B5R-W-3 an APPLY_FAILED request offers "Retry apply" to its requester; a refused apply shows the server explanation', async () => {
    vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(roster([]));
    vi.spyOn(governanceApi, 'listPolicyVersions').mockResolvedValue(withOpen('APPLY_FAILED', true));
    vi.spyOn(governanceApi, 'applyChange').mockRejectedValue(
      new ApiError(409, 'apply failed', 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', { reason: 'apply_failed', explanation: 'The apply failed unexpectedly and was rolled back; it can be retried.' }),
    );
    render(<PolicyView />);
    expect(await screen.findByText('Open request CR-019A0000 · apply failed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry apply' }));
    expect(await screen.findByText('The apply failed unexpectedly and was rolled back; it can be retried.')).toBeInTheDocument();
  });

  it('B5R-W-4 an APPLY_EXPIRED request releases the draft: no Apply button, the hint says so, and "Request activation…" is enabled again', async () => {
    vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(roster([]));
    vi.spyOn(governanceApi, 'listPolicyVersions').mockResolvedValue(
      list({ can_author: true, can_request_activation: true }, { versions: [{ ...DRAFT, latest_request: { id: CR_ID, state: 'APPLY_EXPIRED', applied_at: null } }, ACTIVE] }),
    );
    render(<PolicyView />);
    expect(await screen.findByText('Request CR-019A0000 · apply expired, request activation again')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply activation|Retry apply/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Request activation…' })).toBeEnabled();
    expect(screen.getAllByRole('spinbutton').length).toBeGreaterThan(0);
  });

  // ---- CCP-ACC-1 (TD-ACC-1 Option B) -------------------------------------------------------
  it('ACC-W-1 the requester of an APPLY_FAILED activation sees "Withdraw…": the confirm dialog shows Apply failed → Withdrawn, Withdraw request posts …/withdraw, then the screen reloads', async () => {
    vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(roster([]));
    const listSpy = vi.spyOn(governanceApi, 'listPolicyVersions').mockResolvedValueOnce(withOpen('APPLY_FAILED', true, true)).mockResolvedValue(list({ can_author: true, can_request_activation: true }));
    const withdraw = vi.spyOn(governanceApi, 'withdrawChange').mockResolvedValue({ request: { id: CR_ID, state: 'WITHDRAWN' } });
    render(<PolicyView />);
    expect(await screen.findByText('Open request CR-019A0000 · apply failed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Apply failed')).toBeInTheDocument();
    expect(within(dialog).getByText('Withdrawn')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw request' }));
    await waitFor(() => expect(withdraw).toHaveBeenCalledWith(CR_ID));
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Withdraw…' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Request activation…' })).toBeEnabled();
  });

  it('ACC-W-2 no "Withdraw…" for an approver (withdraw_actionable false) nor for an APPROVED request', async () => {
    vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(roster([]));
    vi.spyOn(governanceApi, 'listPolicyVersions').mockResolvedValueOnce(withOpen('APPLY_FAILED', false, false)).mockResolvedValueOnce(withOpen('APPROVED', true, false));
    const first = render(<PolicyView />);
    expect(await screen.findByText('Open request CR-019A0000 · apply failed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw…' })).toBeNull();
    first.unmount();
    render(<PolicyView />);
    expect(await screen.findByText('Open request CR-019A0000 · approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw…' })).toBeNull();
  });

  it('ACC-W-3 a refused withdrawal keeps the dialog open with the reason (already_applied, apply_in_progress)', async () => {
    vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(roster([]));
    vi.spyOn(governanceApi, 'listPolicyVersions').mockResolvedValue(withOpen('APPLY_FAILED', true, true));
    vi.spyOn(governanceApi, 'withdrawChange')
      .mockRejectedValueOnce(new ApiError(409, 'busy', 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', { reason: 'apply_in_progress' }))
      .mockRejectedValueOnce(new ApiError(409, 'applied', 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', { reason: 'already_applied', reconciled: true }));
    render(<PolicyView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw request' }));
    expect(await within(dialog).findByText('An apply of this request is still running. Try again in a moment.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw request' }));
    expect(await within(dialog).findByText('The activation took effect, so the request is marked applied and can’t be withdrawn.')).toBeInTheDocument();
  });
});

describe('CCP-B5 AuditExplorerView (handoff §5.7)', () => {
  afterEach(() => vi.restoreAllMocks());
  const EV = (o: Partial<AuditEvent>): AuditEvent => ({
    id: '019a0000-0000-7000-8000-00000000e001',
    created_at: '2026-10-24T10:00:00.000Z',
    actor_id: 'u-tomas',
    actor_type: 'user',
    actor_role_keys: ['commercial_ops'],
    event_type: 'COMMERCIAL_CHANGE_REQUEST_SUBMITTED',
    is_exception: false,
    tenant_id: null,
    subject: 'commercial_change_request:x',
    change_request_id: '019a0000-0000-7000-8000-00000000c041',
    policy_version_id: V1,
    payload: { action_type: 'CREDIT', product_key: 'sign' },
    correlation_id: 'c',
    ...o,
  });

  it('B5-W-7 rows read append-only (no row actions); exception events carry the tag; Export runs the read-only server export with the filters and records it', async () => {
    const events = [
      EV({}),
      EV({
        id: '019a0000-0000-7000-8000-00000000e002',
        event_type: 'SUPPORT_EXTENSION_APPLIED',
        is_exception: true,
        actor_role_keys: ['support_admin'],
        change_request_id: null,
      }),
    ];
    const listEv = vi
      .spyOn(governanceApi, 'listAuditEvents')
      .mockResolvedValue({ events, next_cursor: null });
    vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(
      roster([op({ user_id: 'u-tomas', display_name: 'Tomás Silva' })]),
    );
    const exp = vi
      .spyOn(governanceApi, 'exportAudit')
      .mockResolvedValue({
        export_id: 'x',
        exported_at: '2026-10-25T00:00:00.000Z',
        row_count: 1,
        filename: 'commercial-audit.csv',
        content_type: 'text/csv',
        csv: 'id\r\n',
        csv_sha256: 'c'.repeat(64),
      });
    const created: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      created.push('blob');
      return 'blob:x';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    render(
      <MemoryRouter>
        <AuditExplorerView />
      </MemoryRouter>,
    );
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Change request submitted')).toBeInTheDocument();
    expect(screen.getByText('EXCEPTION')).toBeInTheDocument();
    expect(screen.getAllByText('Tomás Silva').length).toBeGreaterThan(0);
    expect(screen.getByText('Append-only · 2 events · newest first')).toBeInTheDocument();
    expect(within(table).queryAllByRole('button')).toHaveLength(0);
    fireEvent.click(screen.getByLabelText('Exceptions only'));
    await waitFor(() =>
      expect(listEv).toHaveBeenCalledWith(expect.objectContaining({ exception_only: true })),
    );
    fireEvent.click(screen.getByRole('button', { name: /^Export CSV/ }));
    await waitFor(() => expect(exp).toHaveBeenCalledWith({ exception_only: true }));
    expect(created).toHaveLength(1);
  });
});

describe('CCP-B5 CommercialRolesSection (handoff §5.8, §3.3)', () => {
  afterEach(() => vi.restoreAllMocks());
  const OWNER = op({
    user_id: 'u-arjun',
    display_name: 'Arjun Rao',
    commercial_role_keys: ['finance_admin', 'platform_owner'],
    role_keys: ['finance_admin', 'platform_owner'],
    is_last_owner: true,
  });
  const AUDITOR = op({
    user_id: 'u-ines',
    display_name: 'Ines Duarte',
    commercial_role_keys: ['read_only_auditor'],
    role_keys: ['read_only_auditor'],
  });
  const SA = op({
    user_id: 'u-maya',
    display_name: 'Maya Okafor',
    role_keys: ['super_admin'],
    attested: false,
  });

  it('B5-W-8 the owner sees the chains, the roster notes and "Request role change…"; removing Platform owner from the last owner is refused in the dialog (commit disabled)', async () => {
    vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(roster([OWNER, AUDITOR, SA]));
    vi.spyOn(governanceApi, 'listPolicyVersions').mockResolvedValue(
      list({ can_author: true, can_request_activation: true }),
    );
    const request = vi.spyOn(governanceApi, 'requestChange');
    render(<CommercialRolesSection session={sess(['platform:approval:read'], 'u-arjun')} />);
    expect(
      await screen.findByText('Last Platform owner — removing this role is refused.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Super admin · no commercial roles')).toBeInTheDocument();
    expect(screen.getByText('Role change (privileged)')).toBeInTheDocument();
    expect(screen.getAllByText('Not fulfillable')).toHaveLength(1);
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Request role change…' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Request role change…' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Request role change · Arjun Rao' });
    fireEvent.click(within(dialog).getByRole('button', { name: '✓ Platform owner' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Refused: Arjun Rao is the last Platform owner. Grant Platform owner to another person first, then remove it here.',
    );
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'x' } });
    fireEvent.change(within(dialog).getByLabelText('Evidence'), { target: { value: 'y' } });
    expect(within(dialog).getByRole('button', { name: 'Submit for approval' })).toBeDisabled();
    expect(request).not.toHaveBeenCalled();
  });

  it('B5-W-9 a role change is submitted only as governed ROLE_GRANT / ROLE_REVOKE requests; a server last-owner refusal is surfaced', async () => {
    vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(
      roster([{ ...OWNER, is_last_owner: false }, AUDITOR]),
    );
    vi.spyOn(governanceApi, 'listPolicyVersions').mockResolvedValue(
      list({ can_author: true, can_request_activation: true }),
    );
    const request = vi
      .spyOn(governanceApi, 'requestChange')
      .mockResolvedValueOnce({
        id: '019a0000-0000-7000-8000-00000000c045',
        action_type: 'ROLE_GRANT',
        state: 'PENDING_APPROVAL',
        policy_version_id: V1,
        required_chain: { rule: 'DISTINCT_PLATFORM_OWNER', steps: [] },
      })
      .mockRejectedValueOnce(
        new ApiError(
          409,
          'the platform must keep at least one active platform_owner',
          'PLATFORM_LAST_OWNER',
          { reason: 'platform_last_owner' },
        ),
      );
    render(<CommercialRolesSection session={sess(['platform:approval:read'], 'u-arjun')} />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Request role change…' }))[1]!);
    const dialog = await screen.findByRole('dialog', { name: 'Request role change · Ines Duarte' });
    fireEvent.click(within(dialog).getByRole('button', { name: '+ Finance admin' }));
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'Cover for Q4 close' },
    });
    fireEvent.change(within(dialog).getByLabelText('Evidence'), { target: { value: 'HR-3391' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]![0]).toMatchObject({
      action_type: 'ROLE_GRANT',
      payload: { subject_user_id: 'u-ines', role_key: 'finance_admin' },
    });
    // A second change: the server refuses the last-owner revoke; the refusal is shown.
    fireEvent.click((await screen.findAllByRole('button', { name: 'Request role change…' }))[0]!);
    const d2 = await screen.findByRole('dialog', { name: 'Request role change · Arjun Rao' });
    fireEvent.click(within(d2).getByRole('button', { name: '✓ Platform owner' }));
    fireEvent.change(within(d2).getByLabelText('Reason'), { target: { value: 'Leaving' } });
    fireEvent.change(within(d2).getByLabelText('Evidence'), { target: { value: 'HR-1' } });
    fireEvent.click(within(d2).getByRole('button', { name: 'Submit for approval' }));
    expect(await within(d2).findByRole('alert')).toHaveTextContent('last Platform owner');
    expect(request.mock.calls.map((c) => c[0].action_type)).toEqual(['ROLE_GRANT', 'ROLE_REVOKE']);
  });

  it('B5-W-10 a non-owner sees the view-only note and no request action', async () => {
    vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(roster([OWNER, AUDITOR]));
    vi.spyOn(governanceApi, 'listPolicyVersions').mockResolvedValue(
      list({ can_author: false, can_request_activation: false }),
    );
    render(<CommercialRolesSection session={sess(['platform:approval:read'], 'u-ines')} />);
    expect(await screen.findByRole('note')).toHaveTextContent(
      'View only. You can view commercial roles. Requesting a role change needs the Platform owner role.',
    );
    expect(screen.queryByRole('button', { name: 'Request role change…' })).toBeNull();
  });
});

// ---- per-role visibility of the B5 routes (6 commercial roles + super_admin) ----------

const ENTRY = 'platform:tenant:read';
const SCOPES: Record<string, string[]> = {
  platform_owner: [
    ENTRY,
    'platform:catalog:read',
    'platform:catalog:approve',
    'platform:catalog:publish',
    'platform:subscription:read',
    'platform:subscription:approve',
    'platform:entitlement:approve',
    'platform:billing:read',
    'platform:billing:approve',
    'platform:approval:read',
    'platform:commercial:audit:read',
  ],
  finance_admin: [
    ENTRY,
    'platform:catalog:read',
    'platform:catalog:approve',
    'platform:subscription:read',
    'platform:subscription:approve',
    'platform:entitlement:approve',
    'platform:billing:read',
    'platform:billing:approve',
    'platform:approval:read',
    'platform:commercial:audit:read',
  ],
  commercial_ops: [
    ENTRY,
    'platform:catalog:read',
    'platform:subscription:read',
    'platform:subscription:request',
    'platform:entitlement:request',
    'platform:billing:read',
    'platform:billing:request',
    'platform:approval:read',
  ],
  catalog_manager: [
    ENTRY,
    'platform:catalog:read',
    'platform:catalog:draft',
    'platform:approval:read',
  ],
  support_admin: [
    ENTRY,
    'platform:catalog:read',
    'platform:subscription:read',
    'platform:subscription:support',
    'platform:billing:read',
    'platform:approval:read',
  ],
  read_only_auditor: [
    ENTRY,
    'platform:catalog:read',
    'platform:subscription:read',
    'platform:billing:read',
    'platform:approval:read',
    'platform:commercial:audit:read',
  ],
  super_admin: [
    'platform:tenant:provision',
    ENTRY,
    'platform:admin:invite',
    'platform:tenant:lifecycle:manage',
    'platform:skill:read',
    'platform:skill:manage',
    'platform:document_template:read',
    'platform:document_template:manage',
    'platform:matching_policy:read',
    'platform:matching_policy:write',
  ],
};
// Expected screen per route: P = the page, D = the in-shell access denied, L = the
// PLATFORM-UX-1 invite page (super_admin).
const EXPECT: Record<string, Record<string, 'P' | 'D' | 'L'>> = {
  '/commercial/policy': {
    platform_owner: 'P',
    finance_admin: 'P',
    commercial_ops: 'P',
    catalog_manager: 'P',
    support_admin: 'P',
    read_only_auditor: 'P',
    super_admin: 'D',
  },
  '/commercial/audit': {
    platform_owner: 'P',
    finance_admin: 'P',
    commercial_ops: 'D',
    catalog_manager: 'D',
    support_admin: 'D',
    read_only_auditor: 'P',
    super_admin: 'D',
  },
  '/admins': {
    platform_owner: 'P',
    finance_admin: 'P',
    commercial_ops: 'P',
    catalog_manager: 'P',
    support_admin: 'P',
    read_only_auditor: 'P',
    super_admin: 'L',
  },
};
const TESTID: Record<string, string> = {
  '/commercial/policy': 'commercial-policy',
  '/commercial/audit': 'commercial-audit',
  '/admins': 'platform-admins',
};

describe('CCP-B5 per-role visibility of the B5 routes (6 roles + super_admin)', () => {
  const realLocation = window.location;
  beforeEach(() => {
    configureAuthConsumer('platform');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...realLocation,
        assign: vi.fn(),
        pathname: '/',
        search: '',
        hash: '',
        origin: 'http://localhost',
      },
    });
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    configureAuthConsumer('recruiter');
    vi.restoreAllMocks();
  });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  for (const [path, byRole] of Object.entries(EXPECT)) {
    for (const [role, want] of Object.entries(byRole)) {
      it(`B5-W-ROLE ${path} as ${role} → ${want === 'P' ? 'the page' : want === 'D' ? 'access denied in the shell' : 'the invite page'}`, async () => {
        const posts: string[] = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const url =
              typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            if ((init?.method ?? 'GET') !== 'GET') posts.push(url);
            if (url.includes('/auth/platform/session'))
              return json(sess(SCOPES[role] ?? [], `u-${role}`));
            if (url.includes('/platform/me'))
              return json({
                user_id: `u-${role}`,
                email: `${role}@aramo.ai`,
                display_name: null,
                tenant_id: 't',
                tenant_name: 'Aramo Platform',
                role_keys: [role],
              });
            if (url.includes('/platform/commercial/policy-versions'))
              return json(list({ can_author: false, can_request_activation: false }));
            if (url.includes('/platform/commercial/operators')) return json(roster([]));
            if (url.includes('/platform/commercial/audit-events'))
              return json({ events: [], next_cursor: null });
            if (url.includes('/platform/tenants')) return json({ tenants: [] });
            return json({}, 404);
          },
        );
        render(
          <MemoryRouter initialEntries={[path]}>
            <App />
          </MemoryRouter>,
        );
        if (want === 'D') {
          expect(await screen.findByTestId('access-denied')).toBeInTheDocument();
          expect(screen.queryByTestId(TESTID[path] as string)).toBeNull();
        } else {
          const page = await screen.findByTestId(TESTID[path] as string);
          if (want === 'L')
            expect(
              within(page).getByRole('heading', { name: 'Invite platform admin' }),
            ).toBeInTheDocument();
          else if (path === '/admins')
            expect(
              within(page).getByRole('heading', { name: 'Approval chains' }),
            ).toBeInTheDocument();
        }
        // Visibility never writes: no POST / PATCH from rendering a page.
        expect(posts).toEqual([]);
      });
    }
  }
});
