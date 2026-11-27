import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Checkbox, Input, Select, type Session } from '@aramo/fe-foundation';

import { EmptyState, Pill, SkeletonPanel, formatDate, shortId } from '../components';
import {
  platformApi,
  type PrivacyChannel,
  type PrivacyQueueFilter,
  type PrivacyRequestStatus,
  type PrivacyRequestSummary,
  type PrivacyRequestType,
  type PrivacySubjectKind,
} from '../platform-api';

import {
  CHANNELS,
  CHANNEL_LABEL,
  STATUSES,
  SUBJECT_KINDS,
  SUBJECT_KIND_LABEL,
  TYPES,
  TYPE_LABEL,
  isFailing,
  isOverdue,
  label,
  privacyErrorText,
  statusPill,
} from './privacy-model';
import '../personal/personal.css';
import './privacy.css';

// PRIV-ADMIN-1 §1.3 — Privacy › Requests: the operators' privacy-request queue,
// ordered by due date (server). Gated on platform:tenant:lifecycle:manage
// (App.tsx), as the API is. The contact email is never shown here.

const LIMITS = [50, 200, 500] as const;

export function ExecutionBanner({ enabled }: { readonly enabled: boolean }) {
  return enabled ? (
    <div
      role="status"
      className="pw-alert pw-alert--warn pw-pr-banner"
      data-testid="privacy-execution-banner"
    >
      <b>Deletion execution is on.</b> An executed deletion runs within minutes and can’t be undone.
    </div>
  ) : (
    <div
      role="status"
      className="pw-alert pw-alert--info pw-pr-banner"
      data-testid="privacy-execution-banner"
    >
      <b>Deletion execution is off.</b> Deletions wait in this queue. Nothing is deleted.
    </div>
  );
}

export function PrivacyRequestsView({ session }: { readonly session: Session }) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<PrivacyQueueFilter>({ limit: 200 });
  const [refDraft, setRefDraft] = useState('');
  const [items, setItems] = useState<PrivacyRequestSummary[] | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setItems(null);
    try {
      const res = await platformApi.listPrivacyRequests(filter);
      setItems(res.items);
      setEnabled(res.execution_enabled);
    } catch (e) {
      setError(privacyErrorText(e, 'Requests couldn’t be loaded. Try again.'));
    }
  }, [filter]);
  useEffect(() => {
    void load();
  }, [load]);

  const set = <K extends keyof PrivacyQueueFilter>(
    k: K,
    v: PrivacyQueueFilter[K] | undefined,
  ): void => {
    setFilter((f) => {
      const next = { ...f };
      if (v === undefined || v === '' || v === false) delete next[k];
      else next[k] = v;
      return next;
    });
  };

  const onSearch = (e: FormEvent): void => {
    e.preventDefault();
    set('reference', refDraft.trim() || undefined);
  };

  const open = (r: PrivacyRequestSummary): void => {
    void navigate(`/privacy-requests/${r.id}`);
  };
  const onRowKey = (e: KeyboardEvent, r: PrivacyRequestSummary): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open(r);
    }
  };

  const now = new Date();
  const n = items?.length ?? 0;
  return (
    <div className="pw-sp pw-pr" data-testid="privacy-requests">
      <div className="pw-sp-head">
        <h1 className="pw-sp-title">Privacy requests</h1>
        <p className="pw-sp-intro">
          Deletion, access, export and correction requests for Aramo Sign, by due date.
        </p>
      </div>
      {enabled !== null ? <ExecutionBanner enabled={enabled} /> : null}

      <div className="pw-filterbar pw-pr-filters">
        <Select
          unstyled
          aria-label="Status"
          className="pw-pr-select"
          value={filter.status ?? ''}
          onChange={(e) =>
            set('status', (e.target.value || undefined) as PrivacyRequestStatus | undefined)
          }
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusPill(s).label}
            </option>
          ))}
        </Select>
        <Select
          unstyled
          aria-label="Type"
          className="pw-pr-select"
          value={filter.request_type ?? ''}
          onChange={(e) =>
            set('request_type', (e.target.value || undefined) as PrivacyRequestType | undefined)
          }
        >
          <option value="">All types</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
        <Select
          unstyled
          aria-label="Subject kind"
          className="pw-pr-select"
          value={filter.subject_kind ?? ''}
          onChange={(e) =>
            set('subject_kind', (e.target.value || undefined) as PrivacySubjectKind | undefined)
          }
        >
          <option value="">All subject kinds</option>
          {SUBJECT_KINDS.map((k) => (
            <option key={k} value={k}>
              {SUBJECT_KIND_LABEL[k]}
            </option>
          ))}
        </Select>
        <Select
          unstyled
          aria-label="Channel"
          className="pw-pr-select"
          value={filter.channel ?? ''}
          onChange={(e) =>
            set('channel', (e.target.value || undefined) as PrivacyChannel | undefined)
          }
        >
          <option value="">All channels</option>
          {CHANNELS.map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABEL[c]}
            </option>
          ))}
        </Select>
        <Select
          unstyled
          aria-label="Show at most"
          className="pw-pr-select"
          value={String(filter.limit ?? 200)}
          onChange={(e) => set('limit', Number(e.target.value))}
        >
          {LIMITS.map((l) => (
            <option key={l} value={l}>
              {l} rows
            </option>
          ))}
        </Select>
        <label className="pw-pr-check">
          <Checkbox
            checked={filter.assigned === 'me'}
            onChange={(e) => set('assigned', e.target.checked ? 'me' : undefined)}
          />
          Assigned to me
        </label>
        <label className="pw-pr-check">
          <Checkbox
            checked={filter.overdue === true}
            onChange={(e) => set('overdue', e.target.checked || undefined)}
          />
          Overdue
        </label>
        <label className="pw-pr-check">
          <Checkbox
            checked={filter.include_closed === true}
            onChange={(e) => set('include_closed', e.target.checked || undefined)}
          />
          Include closed
        </label>
        <form className="pw-pr-search" role="search" onSubmit={onSearch}>
          <Input
            unstyled
            aria-label="Reference"
            className="pw-pr-input"
            placeholder="PR-XXXX-XXXX-XXXX"
            value={refDraft}
            onChange={(e) => setRefDraft(e.target.value)}
          />
          <Button unstyled type="submit" className="pw-btn pw-btn--secondary pw-btn--30">
            Find
          </Button>
        </form>
        <span className="pw-filterbar__count" role="status">
          {items === null ? '' : `${n} ${n === 1 ? 'request' : 'requests'}`}
        </span>
      </div>

      <div className="pw-sp-card">
        {error !== null ? (
          <div role="alert" className="pw-alert pw-alert--error pw-sp-card__alert">
            {error}
          </div>
        ) : null}
        {items === null && error === null ? <SkeletonPanel /> : null}
        {items !== null && items.length === 0 ? (
          <div data-testid="privacy-empty">
            <EmptyState title="No requests match these filters" />
          </div>
        ) : null}
        {items !== null && items.length > 0 ? (
          <div className="pw-sp-scroll">
            <table className="pw-sp-table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Type</th>
                  <th>Subject</th>
                  <th>Channel</th>
                  <th>Status</th>
                  <th>Due</th>
                  <th>Operator</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const pill = statusPill(r.status);
                  const overdue = isOverdue(r, now);
                  const mine =
                    r.assigned_operator_id !== null && r.assigned_operator_id === session.sub;
                  return (
                    <tr
                      key={r.id}
                      className="pw-sp-row"
                      tabIndex={0}
                      aria-label={`Open ${r.reference}`}
                      data-testid={`privacy-row-${r.id}`}
                      onClick={() => open(r)}
                      onKeyDown={(e) => onRowKey(e, r)}
                    >
                      <td className="pw-pr-mono">{r.reference}</td>
                      <td>{label(TYPE_LABEL, r.request_type)}</td>
                      <td>{label(SUBJECT_KIND_LABEL, r.subject_kind)}</td>
                      <td>{label(CHANNEL_LABEL, r.channel)}</td>
                      <td>
                        <span className="pw-pr-badges">
                          <Pill tone={pill.tone}>{pill.label}</Pill>
                          {isFailing(r) ? (
                            <Pill tone="danger" dot={false}>
                              Failing
                            </Pill>
                          ) : null}
                        </span>
                        <div className="pw-sp-row__sub" title={r.status_label}>
                          {r.status_label}
                        </div>
                      </td>
                      <td className="pw-sp-nowrap">
                        {formatDate(r.due_at)}
                        {overdue ? (
                          <div>
                            <Pill tone="danger" size="sm">
                              Overdue
                            </Pill>
                          </div>
                        ) : null}
                      </td>
                      <td title={r.assigned_operator_id ?? undefined}>
                        {r.assigned_operator_id === null
                          ? '—'
                          : mine
                            ? 'You'
                            : shortId(r.assigned_operator_id)}
                      </td>
                      <td className="pw-pr-mono">{r.outcome_code ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
