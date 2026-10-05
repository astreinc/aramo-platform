import { hasScope, type Session, useSession } from '@aramo/fe-foundation';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Card, DataTable, InlineAlert, PageHeader, StatusPill, type TableColumn } from '../ui';

import { getOfferStartWorklist, type OfferStartWorklistRow } from './offer-start-worklist-api';

// Offer & Start §9 — the cross-requisition Offer & Start worklist page (nav label: Placements).
// A READ-ONLY operating surface over the BE-composed projection: people anywhere in the Offer →
// Start journey (including those with an Offer but no PlacementProcess yet), exception-first. It
// owns no state, derives no phase locally, and never fetches-all-then-filters — the server returns
// the visibility-scoped, pre-sorted rows. Every row deep-links to the SAME person × requisition
// journey at /offer-start/:pipeline_id (the single journey surface; this list never duplicates it).
export interface OfferStartWorklistViewProps {
  /** Test seam mirroring the house useSession + sessionOverride pattern. */
  readonly sessionOverride?: Session;
  readonly getWorklistFn?: () => Promise<{ items: readonly OfferStartWorklistRow[] }>;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; rows: readonly OfferStartWorklistRow[] }
  | { status: 'error' };

// Exception phases drive the danger tone; the rest read as ordinary progress.
function phaseTone(row: OfferStartWorklistRow): 'danger' | 'ok' | 'brand' | 'info' {
  if (row.has_exception) return 'danger';
  if (row.phase === 'STARTED') return 'ok';
  if (row.phase === 'READY' || row.phase === 'ACCEPTED') return 'brand';
  return 'info';
}

export function OfferStartWorklistView({ sessionOverride, getWorklistFn }: OfferStartWorklistViewProps) {
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  // The worklist is journey episodes — gated by pipeline:read (the same authority as the journey),
  // NOT placement:read (a row may have no placement yet).
  const canRead = session !== null && Array.isArray(session.scopes) && hasScope(session, 'pipeline:read');

  const getFun = getWorklistFn ?? getOfferStartWorklist;
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    if (!canRead) return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    getFun()
      .then((res) => {
        if (!cancelled) setState({ status: 'ready', rows: res.items });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [getFun, canRead]);

  if (!canRead) return null;

  const columns: ReadonlyArray<TableColumn<OfferStartWorklistRow>> = [
    {
      key: 'talent',
      header: 'Talent',
      render: (r) =>
        r.pipeline_id !== null ? (
          <Link to={`/offer-start/${encodeURIComponent(r.pipeline_id)}`} className="rc-link-strong" data-testid={`worklist-row-${r.talent_record_id}`}>
            {r.talent_name ?? 'Talent'}
          </Link>
        ) : (
          <span data-testid={`worklist-row-${r.talent_record_id}`}>{r.talent_name ?? 'Talent'}</span>
        ),
    },
    {
      key: 'requisition',
      header: 'Requisition',
      render: (r) => (
        <span>
          {r.requisition_title ?? 'Requisition'}
          {r.client_name !== null ? <span className="rc-muted-line"> · {r.client_name}</span> : null}
        </span>
      ),
    },
    {
      key: 'phase',
      header: 'Phase',
      render: (r) => (
        <span data-testid={`worklist-phase-${r.talent_record_id}`}>
          <StatusPill tone={phaseTone(r)} dot>{r.phase_label}</StatusPill>
        </span>
      ),
    },
    {
      key: 'engagement',
      header: 'Type',
      render: (r) => (r.engagement === 'PERMANENT' ? 'Direct hire' : r.engagement === 'CONTRACT' ? 'Contract' : '—'),
    },
  ];

  return (
    <section className="rc-stack" data-testid="offer-start-worklist">
      <PageHeader
        title="Placements"
        description="People across the Offer → Start journey. Exceptions first; open one to work it."
      />
      {state.status === 'loading' && (
        <p className="rc-muted-line" data-testid="worklist-loading">Loading…</p>
      )}
      {state.status === 'error' && (
        <InlineAlert variant="error">Could not load the Offer &amp; Start worklist. Please try again.</InlineAlert>
      )}
      {state.status === 'ready' && (
        <Card flush>
          <DataTable
            columns={columns}
            rows={state.rows}
            rowKey={(r) => `${r.requisition_id}|${r.talent_record_id}`}
            emptyMessage="No one is in the Offer → Start journey yet."
          />
        </Card>
      )}
    </section>
  );
}
