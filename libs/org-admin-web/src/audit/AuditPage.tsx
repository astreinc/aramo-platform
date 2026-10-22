import { safeErrorMessage } from '@aramo/fe-foundation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { OrgPageHeader, SearchIcon } from '../ui/OrgPage';

import { fetchAuditEvents } from './audit-api';
import { ALL_AREAS, AUDIT_AREAS, areaOf, formatWhen, matchesSearch, splitChange, type AuditArea } from './areas';
import type { AuditEventView } from './types';

// ORG-UX-1 (Directive v1.0 LOCKED §8.10; handoff §6.10) — Audit: who changed what in
// the organization. Reads GET /v1/tenant/audit-events (keyset paging via next_cursor,
// "Load more"). Search is client-side over the pages loaded so far (G11 — no server
// search). The Area select maps from the backend `category` + `event_type` (areas.ts).
// Sign-in session events are not organization changes and are not listed.

export const AUDIT_COLUMNS = '150px minmax(150px,1fr) minmax(220px,1.8fr) 110px';
const AUDIT_MIN_WIDTH = 720;

interface Row {
  readonly event: AuditEventView;
  readonly area: AuditArea;
}

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'error'; readonly message: string };

export function AuditPage() {
  const [events, setEvents] = useState<readonly AuditEventView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [more, setMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const [q, setQ] = useState('');
  const [area, setArea] = useState<string>(ALL_AREAS);

  useEffect(() => {
    let live = true;
    fetchAuditEvents({})
      .then((res) => {
        if (!live) return;
        setEvents(res.items);
        setCursor(res.next_cursor);
        setLoad({ status: 'ready' });
      })
      .catch((e: unknown) => live && setLoad({ status: 'error', message: safeErrorMessage(e, 'We couldn’t load the audit trail.') }));
    return () => {
      live = false;
    };
  }, []);

  const loadMore = useCallback(async () => {
    if (cursor === null) return;
    setMore(true);
    setMoreError('');
    try {
      const res = await fetchAuditEvents({ cursor });
      setEvents((cur) => [...cur, ...res.items]);
      setCursor(res.next_cursor);
    } catch (e: unknown) {
      setMoreError(safeErrorMessage(e, 'We couldn’t load more changes.'));
    } finally {
      setMore(false);
    }
  }, [cursor]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const event of events) {
      const a = areaOf(event);
      if (a === null) continue;
      if (area !== ALL_AREAS && a !== area) continue;
      if (!matchesSearch(event, a, q)) continue;
      out.push({ event, area: a });
    }
    return out;
  }, [events, area, q]);

  return (
    <>
      <OrgPageHeader section="audit" />
      <div className="ox-toolbar">
        <span className="ox-search">
          <SearchIcon />
          <input className="ox-input" type="search" aria-label="Search audit" placeholder="Search person or change" value={q} onChange={(e) => setQ(e.target.value)} data-testid="audit-search" />
        </span>
        <select className="ox-select" aria-label="Area" value={area} onChange={(e) => setArea(e.target.value)} style={{ width: 'auto', minWidth: 160 }} data-testid="audit-area">
          <option value={ALL_AREAS}>{ALL_AREAS}</option>
          {AUDIT_AREAS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--ox-faint)' }}>Organization changes only · each app keeps its own audit</span>
      </div>
      {load.status === 'error' ? (
        <div className="ox-alert ox-alert--error" role="alert">
          {load.message}
        </div>
      ) : (
        <div className="ox-card ox-table-wrap" aria-busy={load.status === 'loading'}>
          <div className="ox-table" role="table" aria-label="Organization changes" style={{ minWidth: AUDIT_MIN_WIDTH }}>
            <div className="ox-tr ox-tr--head" role="row" style={{ gridTemplateColumns: AUDIT_COLUMNS }}>
              <span role="columnheader">When</span>
              <span role="columnheader">Who</span>
              <span role="columnheader">Change</span>
              <span role="columnheader">Area</span>
            </div>
            {rows.map(({ event, area: a }) => {
              const { action, target } = splitChange(event.detail);
              return (
                <div key={event.id} className="ox-tr" role="row" style={{ gridTemplateColumns: AUDIT_COLUMNS }} data-testid="audit-row">
                  <span role="cell" className="ox-mono" style={{ fontSize: 12, color: 'var(--ox-muted)' }}>
                    <time dateTime={event.created_at}>{formatWhen(event.created_at)}</time>
                  </span>
                  <span role="cell" className="ox-ellipsis" style={{ fontWeight: 600 }}>
                    {event.actor.display}
                  </span>
                  <span role="cell">
                    {action}
                    {target !== null ? <span className="ox-muted"> {target}</span> : null}
                  </span>
                  <span role="cell">
                    <span className="ox-chip" style={{ borderRadius: 12, padding: '2px 9px', whiteSpace: 'nowrap' }}>
                      {a}
                    </span>
                  </span>
                </div>
              );
            })}
            {load.status === 'ready' && rows.length === 0 ? (
              <div className="ox-empty" data-testid="audit-empty">
                No changes match.
              </div>
            ) : null}
          </div>
        </div>
      )}
      {moreError !== '' ? (
        <div className="ox-alert ox-alert--error" role="alert" style={{ marginTop: 12 }}>
          {moreError}
        </div>
      ) : null}
      {load.status === 'ready' && cursor !== null ? (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
          <button type="button" className="ox-btn ox-btn--secondary" disabled={more} onClick={() => void loadMore()} data-testid="audit-load-more">
            {more ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </>
  );
}
