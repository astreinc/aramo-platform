import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Avatar, FUNNEL_BUCKETS, funnelBucket, type FunnelBucketKey } from '../ui';
import { legalNextStates } from '../pipeline/legal-transitions';
import { getTalentRecord, transitionPipeline } from '../pipeline/pipeline-api';
import {
  PIPELINE_NEXT_ACTION,
  type PipelineStatus,
  type PipelineView,
} from '../pipeline/types';

// REQ talent slide-in detail panel. Opens from a talent card in a requisition's
// expanded row. The workflow stepper is a COSMETIC affordance over the governed
// pipeline lifecycle: a stage is clickable only when it is a legal next
// transition (legalNextStates, the FE mirror of the BE matrix), and the backend
// `/v1/pipelines/:id/transition` remains the authority (a rejected move surfaces
// an error, never a silent bypass). So "Placed" cannot be reached except from
// "offer", preserving the offer→placement governance.

// The status a click on each funnel bucket transitions TO (the bucket's canonical
// forward status). Legality is still gated by legalNextStates.
const BUCKET_TARGET: Record<FunnelBucketKey, PipelineStatus> = {
  sourced: 'contacted',
  qualifying: 'qualifying',
  submitted: 'submitted',
  interview: 'interviewing',
  offer: 'offered',
  placed: 'placed',
};
const BUCKET_INDEX: Record<string, number> = Object.fromEntries(
  FUNNEL_BUCKETS.map((b, i) => [b.key, i]),
);

export interface TalentDetailPanelProps {
  readonly entry: PipelineView;
  readonly talentName: string | undefined;
  readonly isNew: boolean;
  readonly reqTitle: string;
  readonly reqCode: string; // e.g. "REQ-2041"
  readonly onClose: () => void;
  readonly onTransitioned: (updated: PipelineView) => void;
}

export function TalentDetailPanel({
  entry,
  talentName,
  isNew,
  reqTitle,
  reqCode,
  onClose,
  onTransitioned,
}: TalentDetailPanelProps): JSX.Element {
  const [detail, setDetail] = useState<{ first_name: string; last_name: string } | null>(null);
  const [busy, setBusy] = useState<FunnelBucketKey | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getTalentRecord(entry.talent_record_id)
      .then((t) => {
        if (!cancelled) setDetail({ first_name: t.first_name, last_name: t.last_name });
      })
      .catch(() => {
        /* names fall back to the passed talentName / — */
      });
    return () => {
      cancelled = true;
    };
  }, [entry.talent_record_id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const currentBucket = funnelBucket(entry.status);
  const currentIdx = BUCKET_INDEX[currentBucket] ?? 0;
  const legal = new Set<PipelineStatus>(legalNextStates(entry.status));

  const move = async (bucket: FunnelBucketKey): Promise<void> => {
    const target = BUCKET_TARGET[bucket];
    if (target === entry.status || !legal.has(target)) return;
    setBusy(bucket);
    setErr(null);
    try {
      const updated = await transitionPipeline(entry.id, { to_status: target });
      onTransitioned(updated);
    } catch {
      setErr('Could not move the talent — the backend rejected this transition.');
    } finally {
      setBusy(null);
    }
  };

  const name =
    talentName ?? (detail ? `${detail.first_name} ${detail.last_name}` : '—');

  return (
    <>
      <div className="rc-cdp__backdrop" aria-hidden="true" onClick={onClose} />
      <aside
        className="rc-cdp"
        role="dialog"
        aria-modal="true"
        aria-label={`${name} — talent detail`}
      >
        <header className="rc-cdp__hd">
          <Avatar name={name} size="md" />
          <div className="rc-cdp__id">
            <div className="rc-cdp__name">
              {name}
              {isNew ? <span className="rc-cdp__new">NEW</span> : null}
            </div>
            <div className="rc-cdp__role">
              {reqTitle} · {reqCode}
            </div>
          </div>
          <button type="button" className="rc-cdp__x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="rc-cdp__body">
          <section className="rc-cdp__sec">
            <div className="rc-cdp__seclabel">Workflow status</div>
            <ol className="rc-cdp__steps">
              {FUNNEL_BUCKETS.map((b, i) => {
                const done = i < currentIdx;
                const current = i === currentIdx;
                const target = BUCKET_TARGET[b.key];
                const clickable = target !== entry.status && legal.has(target);
                return (
                  <li key={b.key}>
                    <button
                      type="button"
                      disabled={!clickable || busy !== null}
                      onClick={() => void move(b.key)}
                      aria-current={current ? 'step' : undefined}
                      className={`rc-cdp__step${current ? ' rc-cdp__step--current' : ''}${
                        done ? ' rc-cdp__step--done' : ''
                      }${clickable ? ' rc-cdp__step--click' : ''}`}
                    >
                      <span className="rc-cdp__dot" aria-hidden="true">
                        {done ? '✓' : ''}
                      </span>
                      <span className="rc-cdp__steplabel">{b.label}</span>
                      {current ? <span className="rc-cdp__chip">CURRENT</span> : null}
                    </button>
                  </li>
                );
              })}
            </ol>
            {err ? <p className="rc-cdp__err">{err}</p> : null}
            <p className="rc-cdp__note">Every change is logged to the audit trail.</p>
          </section>

          <section className="rc-cdp__sec">
            <div className="rc-cdp__seclabel">Talent details</div>
            <div className="rc-cdp__grid">
              <Field label="First name" value={detail?.first_name ?? '—'} />
              <Field label="Last name" value={detail?.last_name ?? '—'} />
              <Field label="Email" value="—" />
              <Field label="Phone" value="—" />
              <Field label="Location" value="—" />
              <Field label="Work authorization" value="—" />
            </div>
          </section>

          <section className="rc-cdp__sec">
            <div className="rc-cdp__seclabel">Rates — this position</div>
            <div className="rc-cdp__rates">
              <div className="rc-cdp__rate">
                <div className="rc-cdp__ratelabel">Desired rate</div>
                <div className="rc-cdp__rateval mono">—</div>
              </div>
              <div className="rc-cdp__rate rc-cdp__rate--agreed">
                <div className="rc-cdp__ratelabel">Agreed pay rate</div>
                <div className="rc-cdp__rateval mono">—</div>
              </div>
            </div>
          </section>

          <div className="rc-cdp__next">
            <span className="rc-cdp__nextl">Next step</span>
            {PIPELINE_NEXT_ACTION[entry.status]}
          </div>
        </div>

        <footer className="rc-cdp__ft">
          <Link
            to={`/talent/${entry.talent_record_id}`}
            className="rc-cdp__btn rc-cdp__btn--sec"
          >
            Open full profile
          </Link>
          <Link
            to={`/talent/${entry.talent_record_id}`}
            className="rc-cdp__btn rc-cdp__btn--pri"
          >
            Log activity
          </Link>
        </footer>
      </aside>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rc-cdp__field">
      <div className="rc-cdp__fieldl">{label}</div>
      <div className="rc-cdp__fieldv">{value}</div>
    </div>
  );
}
