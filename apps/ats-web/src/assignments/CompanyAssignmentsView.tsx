import {
  ApiError,
  Button,
  Input,
  useToast,
} from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { formatInstant } from '../format/date';
import {
  Avatar,
  InlineAlert,
  PageHeader,
} from '../ui';
import {
  fetchAssignableUsers,
  fetchPickerRoles,
  fetchTenantUsers,
  resolveUserNames,
  type AssignableUser,
} from '../users/users-api';

import {
  assignUserToCompany,
  fetchCompanyAssignments,
  unassignUserFromCompany,
} from './assignments-api';
import {
  messageForAssignUser,
  messageForFetchCompanyAssignments,
  messageForUnassignUser,
  type ErrorMessage,
} from './error-messages';
import type { UserClientAssignmentRow } from './types';

// Company Account team — the assignment surface (user → company). Rebuilt to
// Company Detail.dc.html's "Account team" tab: a rich table (Member / Role /
// Access / Assigned / Remove) + an "+ Add member" search picker (avatar · name ·
// email · role rows). Used as the detail-page tab (companyIdOverride) and at the
// deep-link route /companies/:companyId/assignments.
//
// Auth/visibility (unchanged): the members here gate who can see the client's
// requisitions (AUTHZ-D4b). Idempotency (uniform): POST duplicate → silent
// success; DELETE 404 → success. §5 D4c two-source split:
//   · picker roster → fetchAssignableUsers (BROAD active roster; this view
//     CREATES mappings, so it must NOT client-self-filter)
//   · assigned/actor NAME display → resolveUserNames (directory; incl. departed)
//   · email + ROLE enrichment → fetchTenantUsers + roles-catalog (admin-gated;
//     try-read + graceful fallback — a non-admin manager still sees names).

interface Props {
  companyIdOverride?: string;
  // canManage gates the Add / Remove affordances (company:assign). Undefined ⇒
  // managed (the standalone route is admin-gated; keeps tests permissive).
  canManage?: boolean;
  fetchAssignmentsFn?: (id: string) => Promise<{ items: readonly UserClientAssignmentRow[] }>;
  fetchAssignableFn?: (companyId?: string) => Promise<readonly AssignableUser[]>;
  resolveNamesFn?: (userIds?: readonly string[]) => Promise<Record<string, string>>;
  enrichFn?: () => Promise<Record<string, UserEnrich>>;
  assignFn?: typeof assignUserToCompany;
  unassignFn?: typeof unassignUserFromCompany;
}

// The wired email + role for a user (both optional — masked when the admin
// roster is not readable by the current actor).
export interface UserEnrich {
  readonly email?: string;
  readonly role?: string;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; rows: readonly UserClientAssignmentRow[] }
  | { status: 'error'; message: string };

interface PendingRemoval {
  readonly userId: string;
  readonly stage: 'confirm' | 'removing';
}

// email + role from the admin roster (fetchTenantUsers) joined to the
// roles-catalog labels. Any failure (e.g. a manager without user:read) → {} so
// the surface degrades to names only rather than 403-ing the whole tab.
async function loadEnrich(): Promise<Record<string, UserEnrich>> {
  try {
    const [usersRes, roles] = await Promise.all([
      fetchTenantUsers(),
      fetchPickerRoles(),
    ]);
    const labelByKey: Record<string, string> = {};
    for (const r of roles) labelByKey[r.key] = r.label;
    const m: Record<string, UserEnrich> = {};
    for (const u of usersRes.items) {
      const labels = u.role_keys.map((k) => labelByKey[k] ?? k).filter(Boolean);
      m[u.user_id] = {
        email: u.email !== '' ? u.email : undefined,
        role: labels.length > 0 ? labels.join(', ') : undefined,
      };
    }
    return m;
  } catch {
    return {};
  }
}

export function CompanyAssignmentsView({
  companyIdOverride,
  canManage,
  fetchAssignmentsFn,
  fetchAssignableFn,
  resolveNamesFn,
  enrichFn,
  assignFn,
  unassignFn,
}: Props = {}) {
  const params = useParams<{ companyId?: string }>();
  const companyId = companyIdOverride ?? params.companyId ?? '';
  const embedded = companyIdOverride !== undefined;
  const canAssign = canManage ?? true;

  const fetchAssignmentsFun = fetchAssignmentsFn ?? fetchCompanyAssignments;
  const fetchAssignableFun = fetchAssignableFn ?? fetchAssignableUsers;
  const resolveNamesFun = resolveNamesFn ?? resolveUserNames;
  const enrichFun = enrichFn ?? loadEnrich;
  const assignFun = assignFn ?? assignUserToCompany;
  const unassignFun = unassignFn ?? unassignUserFromCompany;
  const toast = useToast();

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [pickerUsers, setPickerUsers] = useState<readonly AssignableUser[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [enrich, setEnrich] = useState<Record<string, UserEnrich>>({});

  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [pickOpen, setPickOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [addError, setAddError] = useState<ErrorMessage | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);

  const refresh = () => {
    setState({ status: 'loading' });
    fetchAssignmentsFun(companyId)
      .then((view) => {
        setState({ status: 'ready', rows: view.items });
        void resolveNamesFun(
          view.items.flatMap((r) =>
            r.assigned_by_id !== null ? [r.user_id, r.assigned_by_id] : [r.user_id],
          ),
        ).then((m) => setNames((prev) => ({ ...prev, ...m })));
      })
      .catch((err: unknown) => {
        const msg = messageForFetchCompanyAssignments(err);
        setState({ status: 'error', message: msg.title });
      });
  };

  useEffect(() => {
    let cancelled = false;
    fetchAssignmentsFun(companyId)
      .then((view) => {
        if (cancelled) return;
        setState({ status: 'ready', rows: view.items });
        void resolveNamesFun(
          view.items.flatMap((r) =>
            r.assigned_by_id !== null ? [r.user_id, r.assigned_by_id] : [r.user_id],
          ),
        ).then((m) => {
          if (!cancelled) setNames((prev) => ({ ...prev, ...m }));
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = messageForFetchCompanyAssignments(err);
        setState({ status: 'error', message: msg.title });
      });
    // BROAD active roster (no company_id) — this view creates the mappings.
    void fetchAssignableFun()
      .then((users) => {
        if (cancelled) return;
        setPickerUsers(users);
        void resolveNamesFun(users.map((u) => u.user_id)).then((m) => {
          if (!cancelled) setNames((prev) => ({ ...prev, ...m }));
        });
      })
      .catch(() => {
        if (!cancelled) setPickerUsers([]);
      });
    // email + role enrichment (admin-gated; graceful fallback to {}).
    void enrichFun().then((m) => {
      if (!cancelled) setEnrich(m);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchAssignmentsFun, fetchAssignableFun, resolveNamesFun, enrichFun, companyId]);

  const assignedUserIds = useMemo(() => {
    const s = new Set<string>();
    if (state.status === 'ready') for (const r of state.rows) s.add(r.user_id);
    return s;
  }, [state]);

  const nameOf = (userId: string): string =>
    names[userId] ?? pickerUsers.find((u) => u.user_id === userId)?.display_name ?? userId;

  // Assignable users not already on the team, filtered by the search query
  // (name OR email), sorted by name — the "+ Add member" dropdown rows.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...pickerUsers]
      .filter((u) => !assignedUserIds.has(u.user_id))
      .map((u) => ({
        userId: u.user_id,
        name: nameOf(u.user_id),
        email: enrich[u.user_id]?.email,
        role: enrich[u.user_id]?.role,
      }))
      .filter(
        (u) =>
          q === '' ||
          u.name.toLowerCase().includes(q) ||
          (u.email ?? '').toLowerCase().includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [pickerUsers, assignedUserIds, names, enrich, query]);

  const openAdd = () => {
    setAdding(true);
    setAddError(null);
  };
  const cancelAdd = () => {
    setAdding(false);
    setQuery('');
    setSelectedUserId(null);
    setPickOpen(false);
    setAddError(null);
  };
  const pick = (userId: string, name: string) => {
    setSelectedUserId(userId);
    setQuery(name);
    setPickOpen(false);
  };

  const onAdd = async () => {
    if (selectedUserId === null) return;
    setAddError(null);
    setSubmitting(true);
    try {
      await assignFun({ companyId, body: { user_id: selectedUserId } });
      setFlash(`${nameOf(selectedUserId)} added to the account team.`);
      cancelAdd();
      refresh();
    } catch (err: unknown) {
      setAddError(messageForAssignUser(err));
    } finally {
      setSubmitting(false);
    }
  };

  const onConfirmRemove = async () => {
    if (pendingRemoval === null) return;
    const userId = pendingRemoval.userId;
    setPendingRemoval({ userId, stage: 'removing' });
    try {
      await unassignFun({ companyId, userId });
      setFlash(`${nameOf(userId)} removed from the account team.`);
      setPendingRemoval(null);
      refresh();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        setFlash(`${nameOf(userId)} was already removed.`);
        setPendingRemoval(null);
        refresh();
        return;
      }
      toast.show(messageForUnassignUser(err).title);
      setPendingRemoval(null);
    }
  };

  const teamCount = state.status === 'ready' ? state.rows.length : 0;
  const canSubmitAdd = !submitting && selectedUserId !== null;

  return (
    <section className={embedded ? 'rc-mt-16' : 'rc-stack'}>
      {!embedded ? (
        <PageHeader
          title="Account team"
          description="Users assigned to this company."
        />
      ) : null}
      {state.status === 'loading' ? (
        <p className="rc-muted-line">Loading account team…</p>
      ) : null}
      {state.status === 'error' ? (
        <InlineAlert variant="error">{state.message}</InlineAlert>
      ) : null}
      {state.status === 'ready' ? (
        <>
          <div className="rc-team">
            <div className="rc-team__hd">
              <span className="rc-team__hdt">
                <span className="rc-team__title">
                  Account team <span className="rc-team__count">{teamCount}</span>
                </span>
                <span className="rc-team__sub">
                  Members can see and work on this client&rsquo;s requisitions.
                  Recruiters without all-requisition access see only clients
                  they&rsquo;re assigned to.
                </span>
              </span>
              {canAssign ? (
                <Button
                  unstyled
                  type="button"
                  className="rc-team__addbtn"
                  onClick={openAdd}
                  data-testid="team-add-member"
                >
                  + Add member
                </Button>
              ) : null}
            </div>

            {!canAssign ? (
              <div className="rc-team__note">
                You can view the team. Ask an account manager to change
                assignments.
              </div>
            ) : null}

            {canAssign && adding ? (
              <div className="rc-team__add">
                <div className="rc-team__pickwrap">
                  <span className="rc-ef__lb">Team member</span>
                  <Input
                    unstyled
                    className="rc-ef__input rc-team__search"
                    type="text"
                    value={query}
                    placeholder="Search by name or email…"
                    aria-label="Search by name or email"
                    data-testid="assign-user-search"
                    onFocus={() => setPickOpen(true)}
                    onClick={() => setPickOpen(true)}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setSelectedUserId(null);
                      setPickOpen(true);
                    }}
                  />
                  {pickOpen ? (
                    <div className="rc-team__menu" role="listbox">
                      {matches.length === 0 ? (
                        <div className="rc-team__nomatch">
                          No users match{query.trim() !== '' ? ` “${query.trim()}”` : ''}.
                        </div>
                      ) : (
                        matches.map((u) => (
                          <Button
                            key={u.userId}
                            unstyled
                            type="button"
                            role="option"
                            aria-selected={selectedUserId === u.userId}
                            className={`rc-team__opt${selectedUserId === u.userId ? ' rc-team__opt--on' : ''}`}
                            data-testid={`assign-user-option-${u.userId}`}
                            onClick={() => pick(u.userId, u.name)}
                          >
                            <Avatar name={u.name} size="sm" />
                            <span className="rc-team__optm">
                              <span className="rc-team__optn">{u.name}</span>
                              <span className="rc-team__opte">{u.email ?? '—'}</span>
                            </span>
                            <span className="rc-team__optr">{u.role ?? ''}</span>
                          </Button>
                        ))
                      )}
                    </div>
                  ) : null}
                </div>
                <span className="rc-team__addactions">
                  <Button
                    unstyled
                    type="button"
                    className="rc-btn rc-btn--sm"
                    onClick={cancelAdd}
                    disabled={submitting}
                    data-testid="assign-user-cancel"
                  >
                    Cancel
                  </Button>
                  <Button
                    unstyled
                    type="button"
                    className="rc-btn rc-btn--sm rc-btn--primary"
                    onClick={onAdd}
                    disabled={!canSubmitAdd}
                    data-testid="assign-user-submit"
                  >
                    {submitting ? 'Adding…' : 'Add to team'}
                  </Button>
                </span>
                <div className="rc-team__addnote">
                  The member keeps their user role — roles are managed in{' '}
                  <a href="/settings/users" className="rc-link-strong">
                    Settings → Users &amp; roles
                  </a>
                  .
                </div>
                {addError !== null ? (
                  <div className="rc-team__adderr">
                    <InlineAlert variant="error">
                      <strong>{addError.title}</strong>
                      {addError.detail !== undefined ? (
                        <>
                          <br />
                          {addError.detail}
                        </>
                      ) : null}
                    </InlineAlert>
                  </div>
                ) : null}
              </div>
            ) : null}

            {flash !== null ? (
              <div className="rc-team__flash" role="status">
                ✓ {flash}
              </div>
            ) : null}

            <div className="rc-team__tablewrap">
              <div className="rc-team__table">
                <div className="rc-team__row rc-team__row--head">
                  <span>Member</span>
                  <span title="From Settings → Users &amp; roles">Role</span>
                  <span>Access</span>
                  <span>Assigned</span>
                  <span />
                </div>
                {state.rows.length === 0 ? (
                  <p className="rc-empty">No users assigned to this company yet.</p>
                ) : (
                  state.rows.map((r) => {
                    const name = nameOf(r.user_id);
                    const email = enrich[r.user_id]?.email;
                    const role = enrich[r.user_id]?.role;
                    const by =
                      r.assigned_by_id !== null ? `by ${nameOf(r.assigned_by_id)}` : '';
                    const isPending = pendingRemoval?.userId === r.user_id;
                    return (
                      <div
                        className="rc-team__row"
                        key={r.id}
                        data-testid={`assignment-row-${r.user_id}`}
                      >
                        <span className="rc-team__member">
                          <Avatar name={name} size="sm" />
                          <span className="rc-team__mm">
                            <span className="rc-team__mn">{name}</span>
                            {email !== undefined ? (
                              <span className="rc-team__me">{email}</span>
                            ) : null}
                          </span>
                        </span>
                        <span>
                          {role !== undefined ? (
                            <span className="rc-team__rolepill">{role}</span>
                          ) : (
                            <span className="rc-muted-line">—</span>
                          )}
                        </span>
                        <span className="rc-team__access">
                          This client&rsquo;s requisitions
                        </span>
                        <span className="rc-team__assigned">
                          <span className="rc-team__since">
                            {formatInstant(r.assigned_at)}
                          </span>
                          {by !== '' ? (
                            <span className="rc-team__by">{by}</span>
                          ) : null}
                        </span>
                        <span className="rc-team__rm">
                          {canAssign ? (
                            isPending ? (
                              <span className="rc-rowactions">
                                <span className="rc-cell-sub">Remove?</span>
                                <Button
                                  unstyled
                                  type="button"
                                  className="rc-team__rmlink"
                                  onClick={onConfirmRemove}
                                  disabled={pendingRemoval?.stage === 'removing'}
                                  data-testid={`confirm-unassign-${r.user_id}`}
                                >
                                  {pendingRemoval?.stage === 'removing'
                                    ? 'Removing…'
                                    : 'Confirm'}
                                </Button>
                                <Button
                                  unstyled
                                  type="button"
                                  className="rc-team__rmcancel"
                                  onClick={() => setPendingRemoval(null)}
                                  disabled={pendingRemoval?.stage === 'removing'}
                                >
                                  Cancel
                                </Button>
                              </span>
                            ) : (
                              <Button
                                unstyled
                                type="button"
                                className="rc-team__rmlink"
                                onClick={() =>
                                  setPendingRemoval({ userId: r.user_id, stage: 'confirm' })
                                }
                                data-testid={`unassign-${r.user_id}`}
                              >
                                Remove
                              </Button>
                            )
                          ) : null}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
          <p className="rc-team__foot">
            Assignment changes take effect immediately and are logged to the audit
            trail. At least one account manager must remain on the team.
          </p>
        </>
      ) : null}
    </section>
  );
}
