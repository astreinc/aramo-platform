import { useCallback, useEffect, useState } from 'react';
import type { TableColumn } from '@aramo/fe-foundation';

import { Button, DataTable, InlineAlert, StatusPill } from '../../ui';
import { SettingHint } from '../components';

import { fetchAuditEvents } from './audit-api';
import {
  CATEGORY_LABEL,
  CATEGORY_TONE,
  EVENT_TYPE_OPTIONS,
  eventTypeLabel,
} from './event-labels';
import type { AuditEventView, AuditFilters } from './types';

// Settings Rebuild Directive 2 — the Audit log read surface (replaces the
// Directive-1 seam). A real, keyset-paginated, filterable table over the live
// GET /v1/tenant/audit-events. Most-recent-first; "Load more" walks the cursor
// forward (keyset is forward-only by nature). Detail is the backend's redacted,
// human-readable summary — never raw JSON.

interface Props {
  // Test seam.
  readonly fetchFn?: typeof fetchAuditEvents;
}

type LoadState = 'idle' | 'loading' | 'loadingMore' | 'error';

export function AuditLogView({ fetchFn }: Props = {}) {
  const fetcher = fetchFn ?? fetchAuditEvents;

  const [draft, setDraft] = useState<AuditFilters>({});
  const [applied, setApplied] = useState<AuditFilters>({});
  const [rows, setRows] = useState<readonly AuditEventView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string>('');

  const load = useCallback(
    (filters: AuditFilters, mode: 'replace' | 'more', afterCursor: string | null) => {
      setState(mode === 'replace' ? 'loading' : 'loadingMore');
      setError('');
      fetcher({ filters, cursor: mode === 'more' ? afterCursor : null })
        .then((res) => {
          setRows((prev) => (mode === 'replace' ? res.items : [...prev, ...res.items]));
          setCursor(res.next_cursor);
          setState('idle');
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Failed to load the audit log.');
          setState('error');
        });
    },
    [fetcher],
  );

  // Initial load + reload whenever the applied filters change.
  useEffect(() => {
    load(applied, 'replace', null);
  }, [applied, load]);

  const onApply = () => setApplied(normalize(draft));
  const onClear = () => {
    setDraft({});
    setApplied({});
  };

  const columns: ReadonlyArray<TableColumn<AuditEventView>> = [
    {
      key: 'when',
      header: 'When',
      width: '170px',
      render: (r) => <span className="rc-muted-line">{formatWhen(r.created_at)}</span>,
    },
    {
      key: 'event',
      header: 'Event',
      render: (r) => (
        <span className="rc-audit-event">
          <StatusPill tone={CATEGORY_TONE[r.category]}>
            {CATEGORY_LABEL[r.category]}
          </StatusPill>
          <span className="rc-audit-event__label">{eventTypeLabel(r.event_type)}</span>
        </span>
      ),
    },
    { key: 'actor', header: 'Actor', render: (r) => r.actor.display },
    {
      key: 'detail',
      header: 'Detail',
      render: (r) => <span className="rc-audit-detail">{r.detail}</span>,
    },
    {
      key: 'subject',
      header: 'Subject',
      width: '130px',
      render: (r) => (
        <span className="mono rc-audit-subject" title={r.subject_id}>
          {shortId(r.subject_id)}
        </span>
      ),
    },
  ];

  return (
    <div className="rc-stack">
      <form
        className="rc-audit-filters"
        onSubmit={(e) => {
          e.preventDefault();
          onApply();
        }}
      >
        <label className="rc-ifield">
          <span>Event type</span>
          <select
            className="rc-input"
            value={draft.event_type ?? ''}
            onChange={(e) => setDraft({ ...draft, event_type: e.target.value || undefined })}
            data-testid="audit-filter-event-type"
          >
            <option value="">All events</option>
            {EVENT_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="rc-ifield">
          <span>Actor ID</span>
          <input
            className="rc-input"
            value={draft.actor_id ?? ''}
            placeholder="user UUID"
            onChange={(e) => setDraft({ ...draft, actor_id: e.target.value || undefined })}
            data-testid="audit-filter-actor"
          />
        </label>
        <label className="rc-ifield">
          <span>Subject ID</span>
          <input
            className="rc-input"
            value={draft.subject_id ?? ''}
            placeholder="entity UUID"
            onChange={(e) => setDraft({ ...draft, subject_id: e.target.value || undefined })}
            data-testid="audit-filter-subject"
          />
        </label>
        <label className="rc-ifield">
          <span>From</span>
          <input
            className="rc-input"
            type="date"
            value={draft.from ?? ''}
            onChange={(e) => setDraft({ ...draft, from: e.target.value || undefined })}
            data-testid="audit-filter-from"
          />
        </label>
        <label className="rc-ifield">
          <span>To</span>
          <input
            className="rc-input"
            type="date"
            value={draft.to ?? ''}
            onChange={(e) => setDraft({ ...draft, to: e.target.value || undefined })}
            data-testid="audit-filter-to"
          />
        </label>
        <div className="rc-audit-filters__actions">
          <Button type="submit" data-testid="audit-apply">
            Apply
          </Button>
          <Button type="button" variant="ghost" onClick={onClear} data-testid="audit-clear">
            Clear
          </Button>
        </div>
      </form>

      {state === 'error' ? (
        <InlineAlert variant="error">{error}</InlineAlert>
      ) : state === 'loading' ? (
        <p className="set-muted">Loading audit log…</p>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            emptyMessage="No audit events match these filters."
          />
          {cursor !== null ? (
            <div className="rc-audit-more">
              <Button
                variant="secondary"
                onClick={() => load(applied, 'more', cursor)}
                disabled={state === 'loadingMore'}
                data-testid="audit-load-more"
              >
                {state === 'loadingMore' ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <SettingHint>
        The audit log records events — who did what, when. It is read-only and tenant-scoped; sensitive
        values are redacted from the detail unless your role permits them.
      </SettingHint>
    </div>
  );
}

function normalize(f: AuditFilters): AuditFilters {
  const out: {
    event_type?: string;
    actor_id?: string;
    subject_id?: string;
    from?: string;
    to?: string;
  } = {};
  if (f.event_type) out.event_type = f.event_type;
  if (f.actor_id?.trim()) out.actor_id = f.actor_id.trim();
  if (f.subject_id?.trim()) out.subject_id = f.subject_id.trim();
  // A bare date → start-of-day / end-of-day ISO bounds.
  if (f.from) out.from = `${f.from}T00:00:00.000Z`;
  if (f.to) out.to = `${f.to}T23:59:59.999Z`;
  return out;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
