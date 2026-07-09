import { useCallback, useEffect, useState } from 'react';
import { Button, InlineAlert } from '@aramo/fe-foundation';

import { BandPill } from '../../ui';
import {
  getDossier,
  getDossierEvidence,
  type ContradictionItem,
  type DossierEvidenceItem,
  type DossierHead,
} from '../dossier-api';

import { ContradictionResolveDialog } from './ContradictionResolveDialog';

// The four trust dimensions, canonical order.
const DIMENSIONS = [
  { key: 'identity', label: 'Identity' },
  { key: 'claims', label: 'Claims' },
  { key: 'continuity', label: 'Continuity' },
  { key: 'eligibility', label: 'Eligibility' },
] as const;

interface Props {
  readonly talentId: string;
  /** identity:resolve — gates the contradiction resolve action (TR-4). */
  readonly canResolve: boolean;
}

// TR-14 B2 (§3.4) — the Trust tab: the Trust Assessment form for a promoted
// talent, read-only. Per-dimension bands + named-thinness statements (never a
// number), contradiction ITEMS a reviewer can resolve inline (the TR-4 arm),
// verification state, merge provenance, the evidence timeline, and the honest
// empty state. Confident-blue; no new pill kinds; no ordinal rendered.
export function TrustPanel({ talentId, canResolve }: Props) {
  const [head, setHead] = useState<DossierHead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<ContradictionItem | null>(null);

  const [timeline, setTimeline] = useState<DossierEvidenceItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [timelineBusy, setTimelineBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const h = await getDossier(talentId);
      setHead(h);
      if (h.ledger_established) {
        const page = await getDossierEvidence(talentId, null);
        setTimeline([...page.items]);
        setNextCursor(page.next_cursor);
      }
    } catch {
      setError('Could not load the trust assessment.');
    } finally {
      setLoading(false);
    }
  }, [talentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (nextCursor === null) return;
    setTimelineBusy(true);
    try {
      const page = await getDossierEvidence(talentId, nextCursor);
      setTimeline((prev) => [...prev, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch {
      /* keep what we have; a transient timeline error is non-blocking */
    } finally {
      setTimelineBusy(false);
    }
  };

  if (loading) return <p className="rc-drawer__empty">Loading trust assessment…</p>;
  if (error !== null) return <InlineAlert variant="error">{error}</InlineAlert>;
  if (head === null) return null;

  if (!head.ledger_established) {
    return (
      <div className="rc-trust">
        <p className="rc-trust__empty">No evidence ledger for this record.</p>
      </div>
    );
  }

  return (
    <div className="rc-trust">
      <section className="rc-trust__sec">
        <h4>Assessment</h4>
        <div className="rc-trust-bands">
          {DIMENSIONS.map((d) => (
            <div key={d.key} className="rc-trust-band">
              <span className="rc-trust-band__dim">{d.label}</span>
              <BandPill band={head.dimensions[d.key].band} />
            </div>
          ))}
        </div>
        {head.statements.length > 0 ? (
          <ul className="rc-trust-statements">
            {head.statements.map((s) => (
              <li key={s} className="rc-trust-statements__line">
                {s}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {head.contradictions.length > 0 ? (
        <section className="rc-trust__sec">
          <h4>Contradictions</h4>
          <ul className="rc-trust-list">
            {head.contradictions.map((c) => (
              <li key={c.evidence_id} className="rc-trust-item">
                <div className="rc-trust-item__body">
                  <span className="rc-trust-item__type">{c.assertion_type}</span>
                  {c.reason != null && c.reason !== '' ? (
                    <span className="rc-trust-item__reason">{c.reason}</span>
                  ) : (
                    <span className="rc-trust-item__reason">Conflicting evidence</span>
                  )}
                </div>
                {canResolve ? (
                  <Button variant="secondary" onClick={() => setResolving(c)} data-testid="resolve-open">
                    Resolve
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {head.verifications.length > 0 ? (
        <section className="rc-trust__sec">
          <h4>Verification</h4>
          <ul className="rc-trust-list">
            {head.verifications.map((v) => (
              <li key={`${v.anchor_kind}`} className="rc-trust-item">
                <span className="rc-trust-item__type">{v.anchor_kind}</span>
                <span className="rc-trust-item__reason">{v.status}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {head.merge_provenance.length > 0 ? (
        <section className="rc-trust__sec">
          <h4>Identity history</h4>
          <ul className="rc-trust-list">
            {head.merge_provenance.map((m) => (
              <li key={m.operation_id} className="rc-trust-item">
                <span className="rc-trust-item__type">
                  Merged {m.role === 'survivor' ? 'in' : 'into another record'}
                </span>
                {m.completed_at != null ? (
                  <span className="rc-trust-item__reason">{m.completed_at.slice(0, 10)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rc-trust__sec">
        <h4>Timeline</h4>
        {timeline.length === 0 ? (
          <p className="rc-muted-line">No ledger events yet.</p>
        ) : (
          <ul className="rc-trust-list">
            {timeline.map((it) => (
              <li key={it.event.id} className="rc-trust-item">
                <div className="rc-trust-item__body">
                  <span className="rc-trust-item__type">
                    {it.event.event_type} · {it.evidence.assertion_type}
                  </span>
                  <span className="rc-trust-item__reason">{it.event.occurred_at.slice(0, 10)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {nextCursor !== null ? (
          <Button variant="secondary" onClick={() => void loadMore()} disabled={timelineBusy}>
            {timelineBusy ? 'Loading…' : 'Load more'}
          </Button>
        ) : null}
      </section>

      <ContradictionResolveDialog
        item={resolving}
        onClose={() => setResolving(null)}
        onResolved={() => void load()}
      />
    </div>
  );
}
