import { useEffect, useRef, useState } from 'react';
import { InlineAlert, useToast } from '@aramo/fe-foundation';

import { Avatar, BandPill, Button, Icons, StatusPill } from '../../ui';
import { addToPipeline, getSubjectDetail, saveToBench } from '../sourcing-api';
import { deferralGuidance, promoteErrorMessage, subjectErrorMessage } from '../error-messages';
import type { PoolItem, SourcingResult, SubjectAdvisory, SubjectDetail } from '../types';

import { AdvisoryResolveDialog, type AdvisoryAction } from './AdvisoryResolveDialog';
import { SourcingAddToPipelineDialog } from './SourcingAddToPipelineDialog';

interface Props {
  /** The selected pool row (header fallback while the detail loads); null = closed. */
  readonly item: PoolItem | null;
  readonly index: number;
  readonly total: number;
  /** identity:resolve — gates the advisory approve/dismiss actions. */
  readonly canResolve: boolean;
  readonly onClose: () => void;
  readonly onPrev: () => void;
  readonly onNext: () => void;
  /** A successful promote removes the subject from the pool → refresh + close. */
  readonly onPromoted: () => void;
}

// The four trust dimensions, in canonical order, paired with their wire key.
const DIMENSIONS = [
  { key: 'identity', label: 'Identity' },
  { key: 'claims', label: 'Claims' },
  { key: 'continuity', label: 'Continuity' },
  { key: 'eligibility', label: 'Eligibility' },
] as const;

function collectedOn(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// SourcingSubjectDrawer — the subject drill-in (forked from TalentTriageDrawer):
// same non-modal right slide-in + focus-trap + prev/next, but the body is the
// sourcing subject: the 4 trust BandPills, the evidence ledger (assertion /
// source / method / status / date — NEVER strength, R10), the identity refs, and
// the pending same-human advisories with inline approve/dismiss (identity:resolve
// -gated). The footer promotes: Add to pipeline / Save to pool, both reading the
// SOURCED_TALENT ref_id off refs[]. A deferral renders as guidance, not an error.
export function SourcingSubjectDrawer({
  item,
  index,
  total,
  canResolve,
  onClose,
  onPrev,
  onNext,
  onPromoted,
}: Props) {
  const [detail, setDetail] = useState<SubjectDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [promoteBusy, setPromoteBusy] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  // A deferral is guidance, not an error — its own calm inline surface.
  const [guidance, setGuidance] = useState<string | null>(null);
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [advisoryTarget, setAdvisoryTarget] = useState<
    { advisory: SubjectAdvisory; action: AdvisoryAction } | null
  >(null);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const toast = useToast();

  const subjectId = item?.subject_id ?? null;

  useEffect(() => {
    if (subjectId === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setGuidance(null);
    setPromoteError(null);
    getSubjectDetail(subjectId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) {
          setDetail(null);
          setError(subjectErrorMessage(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [subjectId, refreshKey]);

  // a11y: capture the trigger, move focus into the drawer on open, restore on
  // close; Esc closes; Tab is trapped within the drawer (dialog semantics).
  useEffect(() => {
    if (subjectId === null) return;
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
    const toRestore = restoreRef.current;
    return () => toRestore?.focus();
  }, [subjectId]);

  useEffect(() => {
    if (subjectId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = asideRef.current;
      if (root === null) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [subjectId, onClose]);

  if (item === null) return null;

  const displayName = detail?.display_name ?? item.display_name;
  const email = detail?.email ?? item.email;
  const heading = displayName ?? email ?? 'Unnamed subject';
  const bands = detail?.trust_bands ?? item.trust_bands;
  const contradictions = detail?.open_contradiction_count ?? item.open_contradiction_count;
  const advisories = detail?.open_identity_advisories ?? [];
  // The promote POSTs address the subject by its SOURCED_TALENT ref (I15: no
  // TalentRecord exists yet). A pool subject always carries one (the anti-join);
  // guard anyway so promote can't fire without it.
  const sourcedRefId =
    detail?.refs.find((r) => r.ref_type === 'SOURCED_TALENT')?.ref_id ?? null;
  const canPromote = sourcedRefId !== null && !promoteBusy;

  const applyResult = (result: SourcingResult, successCopy: string) => {
    if (result.status === 'promoted' || result.status === 'already_promoted') {
      toast.show(successCopy);
      onPromoted();
      return;
    }
    // Any deferred_* — expected, render as guidance and keep the drawer open so
    // the sourcer can act (e.g. resolve the identity flag below).
    setGuidance(deferralGuidance(result.status));
  };

  const runAddToPipeline = async (requisitionId: string) => {
    if (sourcedRefId === null) return;
    setPromoteBusy(true);
    setPromoteError(null);
    setGuidance(null);
    try {
      const res = await addToPipeline({
        ref_type: 'SOURCED_TALENT',
        ref_id: sourcedRefId,
        requisition_id: requisitionId,
      });
      setPipelineOpen(false);
      applyResult(res, 'Added to pipeline.');
    } catch (err) {
      setPromoteError(promoteErrorMessage(err));
    } finally {
      setPromoteBusy(false);
    }
  };

  const runSaveToBench = async () => {
    if (sourcedRefId === null) return;
    setPromoteBusy(true);
    setPromoteError(null);
    setGuidance(null);
    try {
      const res = await saveToBench({ ref_type: 'SOURCED_TALENT', ref_id: sourcedRefId });
      applyResult(res, 'Saved to the talent pool.');
    } catch (err) {
      setPromoteError(promoteErrorMessage(err));
    } finally {
      setPromoteBusy(false);
    }
  };

  return (
    <aside
      ref={asideRef}
      className="rc-drawer rc-drawer--open rc-sourcing-drawer"
      role="dialog"
      aria-modal="false"
      aria-label={`${heading} — sourcing subject`}
    >
      <div className="rc-drawer__hd">
        <button
          type="button"
          className="rc-drawer__nav"
          aria-label="Previous subject"
          onClick={onPrev}
          disabled={index <= 0}
        >
          <Icons.IconChevronLeft />
        </button>
        <button
          type="button"
          className="rc-drawer__nav"
          aria-label="Next subject"
          onClick={onNext}
          disabled={index >= total - 1}
        >
          <Icons.IconChevronRight />
        </button>
        <span className="rc-drawer__pos num">
          {index + 1} of {total}
        </span>
        <button type="button" className="rc-drawer__x" aria-label="Close" onClick={onClose}>
          <Icons.IconX />
        </button>
      </div>

      <div className="rc-drawer__body">
        <div className="rc-drawer__id">
          <Avatar name={heading} size="lg" />
          <div>
            <h3 ref={headingRef} tabIndex={-1}>
              {heading}
            </h3>
            {email !== null ? <div className="rc-drawer__rl mono">{email}</div> : null}
          </div>
        </div>

        <section className="rc-drawer__sec">
          <h4>Trust</h4>
          <div className="rc-sourcing-bands">
            {DIMENSIONS.map((d) => (
              <div key={d.key} className="rc-sourcing-band">
                <span className="rc-sourcing-band__dim">{d.label}</span>
                <BandPill band={bands[d.key]} />
              </div>
            ))}
          </div>
          {contradictions > 0 ? (
            <div className="rc-sourcing-contra">
              <StatusPill tone="warn" dot>
                {contradictions === 1
                  ? '1 open contradiction'
                  : `${contradictions} open contradictions`}
              </StatusPill>
            </div>
          ) : null}
        </section>

        {loading ? (
          <p className="rc-drawer__empty">Loading subject…</p>
        ) : error !== null ? (
          <div className="rc-drawer__sec">
            <InlineAlert variant="error">{error}</InlineAlert>
          </div>
        ) : (
          <>
            <section className="rc-drawer__sec">
              <h4>Pending identity review</h4>
              {advisories.length === 0 ? (
                <p className="rc-drawer__empty">No pending identity advisories.</p>
              ) : (
                <ul className="rc-sourcing-adv">
                  {advisories.map((a) => (
                    <li key={a.id} className="rc-sourcing-adv__row">
                      <div className="rc-sourcing-adv__meta">
                        <StatusPill tone={a.has_contradiction ? 'danger' : 'info'}>
                          {a.has_contradiction ? 'Possible match · contradiction' : 'Possible match'}
                        </StatusPill>
                        <span className="rc-sourcing-adv__id mono">{a.subject_b_id}</span>
                      </div>
                      {canResolve ? (
                        <div className="rc-sourcing-adv__act">
                          <Button
                            variant="secondary"
                            onClick={() => setAdvisoryTarget({ advisory: a, action: 'dismiss' })}
                          >
                            Dismiss
                          </Button>
                          <Button
                            variant="primary"
                            onClick={() => setAdvisoryTarget({ advisory: a, action: 'approve' })}
                          >
                            Approve merge
                          </Button>
                        </div>
                      ) : (
                        <p className="rc-sourcing-adv__note">
                          Resolving identity needs the identity:resolve permission.
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rc-drawer__sec">
              <h4>Evidence</h4>
              {detail === null || detail.evidence.length === 0 ? (
                <p className="rc-drawer__empty">No evidence recorded yet.</p>
              ) : (
                <ul className="rc-sourcing-ev">
                  {detail.evidence.map((e) => (
                    <li key={e.id} className="rc-sourcing-ev__row">
                      <div className="rc-sourcing-ev__top">
                        <span className="rc-sourcing-ev__type">{e.assertion_type}</span>
                        <StatusPill tone={e.current_status === 'VALID' ? 'ok' : 'neutral'}>
                          {e.current_status}
                        </StatusPill>
                      </div>
                      <div className="rc-sourcing-ev__sub">
                        {e.source_class} · {e.method} · {collectedOn(e.collected_at)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rc-drawer__sec">
              <h4>Identity references</h4>
              {detail === null || detail.refs.length === 0 ? (
                <p className="rc-drawer__empty">No references.</p>
              ) : (
                <div className="rc-kv-list">
                  {detail.refs.map((r) => (
                    <div key={`${r.ref_type}:${r.ref_id}`} className="rc-kv">
                      <span className="rc-kv__k">{r.ref_type}</span>
                      <span className="rc-kv__v mono">{r.ref_id}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {guidance !== null ? (
          <div className="rc-drawer__sec">
            <InlineAlert variant="error">{guidance}</InlineAlert>
          </div>
        ) : null}
        {promoteError !== null ? (
          <div className="rc-drawer__sec">
            <InlineAlert variant="error">{promoteError}</InlineAlert>
          </div>
        ) : null}
      </div>

      <div className="rc-drawer__foot rc-sourcing-foot">
        <Button
          variant="secondary"
          onClick={() => void runSaveToBench()}
          disabled={!canPromote}
        >
          <Icons.IconUsers /> Save to pool
        </Button>
        <Button
          variant="primary"
          onClick={() => setPipelineOpen(true)}
          disabled={!canPromote}
        >
          <Icons.IconBriefcase /> Add to pipeline
        </Button>
      </div>

      <SourcingAddToPipelineDialog
        open={pipelineOpen}
        busy={promoteBusy}
        onClose={() => setPipelineOpen(false)}
        onPick={(reqId) => void runAddToPipeline(reqId)}
      />
      <AdvisoryResolveDialog
        advisory={advisoryTarget?.advisory ?? null}
        action={advisoryTarget?.action ?? 'dismiss'}
        onClose={() => setAdvisoryTarget(null)}
        onResolved={() => setRefreshKey((k) => k + 1)}
      />
    </aside>
  );
}
