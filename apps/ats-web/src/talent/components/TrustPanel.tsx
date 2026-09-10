import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { BandPill, Button, Card, InlineAlert, StatusPill, type PillTone } from '../../ui';
import {
  getDossier,
  getDossierEvidence,
  type ContradictionItem,
  type DossierEvidenceItem,
  type DossierHead,
} from '../dossier-api';

import { ContradictionResolveDialog } from './ContradictionResolveDialog';

// Proposal kind → reader label for the pointer line (words, never numbers — R10).
const PROPOSAL_POINTER_LABEL: Record<string, string> = {
  VERIFY_CONTACT: 'Verify contact',
  RENEW_VERIFICATION: 'Renew verification',
  RESOLVE_CONTRADICTION: 'Resolve contradiction',
};

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

  if (loading) return <p className="talent-detail__empty">Loading trust assessment…</p>;
  if (error !== null) return <InlineAlert variant="error">{error}</InlineAlert>;
  if (head === null) return null;

  const established = head.ledger_established;
  const proposalKinds = [
    ...new Set(
      (head.proposal_pointers ?? []).map((p) => PROPOSAL_POINTER_LABEL[p.kind] ?? p.kind),
    ),
  ];

  return (
    <>
      {/* Trust & Evidence — the prototype's claim-row card, driven by the REAL
          dossier. Each dimension / verification / identity-history entry is a
          "claim" row with a right-aligned, named state (never a number, R10). */}
      <Card>
        <div className="talent-detail__ctitle">Trust &amp; evidence</div>
        <div className="talent-detail__note" style={{ marginTop: 0 }}>
          Named, explainable states per claim — never an opaque number. Human
          disposition is recorded.
        </div>

        {!established ? (
          <p className="talent-detail__empty">No evidence ledger for this record yet.</p>
        ) : (
          <div className="talent-detail__trows">
            {DIMENSIONS.map((d) => (
              <TRow
                key={d.key}
                title={d.label}
                right={<BandPill band={head.dimensions[d.key].band} />}
              />
            ))}
            {head.verifications.map((v) => (
              <TRow
                key={`v-${v.anchor_kind}`}
                title={v.anchor_kind}
                evidence="Verification anchor"
                right={
                  <StatusPill tone={verificationTone(v.status)} dot>
                    {v.status}
                  </StatusPill>
                }
              />
            ))}
            {head.merge_provenance.map((m) => (
              <TRow
                key={m.operation_id}
                title={`Identity — merged ${m.role === 'survivor' ? 'in' : 'into another record'}`}
                evidence={m.completed_at != null ? m.completed_at.slice(0, 10) : undefined}
                right={<StatusPill tone="neutral" dot>Merge history</StatusPill>}
              />
            ))}
          </div>
        )}

        {head.statements.length > 0 ? (
          <ul className="talent-detail__tstatements">
            {head.statements.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        ) : null}

        {/* TR-12 B2 — pointer toward the Trust Proposals queue; OPEN kinds as
            words (R10, no count). The queue is the source of truth. */}
        {proposalKinds.length > 0 ? (
          <div className="talent-detail__note">
            Open trust proposals: {proposalKinds.join(', ')}.{' '}
            <Link to="/trust/proposals">Go to Trust Proposals →</Link>
          </div>
        ) : null}
      </Card>

      {/* The contradiction "attention" panel — the prototype's amber call-out,
          built from REAL contradiction items. The resolve action (TR-4) is
          gated on identity:resolve. */}
      {head.contradictions.length > 0 ? (
        <div className="talent-detail__attention">
          <div className="talent-detail__attention-title">Why this needs attention</div>
          {head.contradictions.map((c) => (
            <div key={c.evidence_id} className="talent-detail__attention-row">
              <div className="talent-detail__attention-body">
                {c.reason != null && c.reason !== '' ? c.reason : 'Conflicting evidence'}
                <span className="talent-detail__attention-meta"> · {c.assertion_type}</span>
              </div>
              {canResolve ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setResolving(c)}
                  data-testid="resolve-open"
                >
                  Resolve
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {established ? (
        <Card>
          <div className="talent-detail__ctitle">Evidence timeline</div>
          {timeline.length === 0 ? (
            <p className="talent-detail__empty">No ledger events yet.</p>
          ) : (
            <div className="talent-detail__trows">
              {timeline.map((it) => (
                <TRow
                  key={it.event.id}
                  title={`${it.event.event_type} · ${it.evidence.assertion_type}`}
                  evidence={it.event.occurred_at.slice(0, 10)}
                />
              ))}
            </div>
          )}
          {nextCursor !== null ? (
            <div style={{ marginTop: 12 }}>
              <Button variant="secondary" size="sm" onClick={() => void loadMore()} disabled={timelineBusy}>
                {timelineBusy ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}

      <ContradictionResolveDialog
        item={resolving}
        onClose={() => setResolving(null)}
        onResolved={() => void load()}
      />
    </>
  );
}

// A prototype "claim" row: title (+ optional evidence sub-line) with a
// right-aligned named state pill.
function TRow({
  title,
  evidence,
  right,
}: {
  title: string;
  evidence?: string;
  right?: ReactNode;
}) {
  return (
    <div className="talent-detail__trow">
      <div className="talent-detail__trow-main">
        <div className="talent-detail__trow-title">{title}</div>
        {evidence !== undefined && evidence !== '' ? (
          <div className="talent-detail__trow-ev">{evidence}</div>
        ) : null}
      </div>
      {right != null ? <div className="talent-detail__trow-state">{right}</div> : null}
    </div>
  );
}

function verificationTone(status: string): PillTone {
  if (/verif|valid|confirm/i.test(status)) return 'ok';
  if (/pend|expir|await/i.test(status)) return 'warn';
  return 'neutral';
}
