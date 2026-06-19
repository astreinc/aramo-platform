import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { listActivities } from '../../activity/activity-api';
import type { ActivityView } from '../../activity/types';
import { listPipelinesForTalent } from '../../pipeline/pipeline-api';
import type { PipelineView } from '../../pipeline/types';
import {
  Avatar,
  Icons,
  ReservedSeam,
  StagePill,
  Tag,
  Button,
} from '../../ui';
import {
  fullName,
  locationOf,
  skillsOf,
  statedRate,
  AVAILABILITY_LABELS,
  ENGAGEMENT_LABELS,
} from '../talent-workspace';
import type { TalentRecordView } from '../types';

// TalentTriageDrawer — right slide-in triage panel. Feature-local; NON-MODAL
// (the list stays visible so the recruiter can page prev/next through results).
// Identity + key facts come from the already-loaded row (no refetch); pipeline
// and activity are live reads. The "Match insight" seam is a Core placeholder —
// the evidence behind a recommendation, never a number (R9/R10 moat) — unwired.

interface DrawerProps {
  readonly talent: TalentRecordView | null;
  readonly index: number;
  readonly total: number;
  readonly onClose: () => void;
  readonly onPrev: () => void;
  readonly onNext: () => void;
  readonly onAddToReq: (t: TalentRecordView) => void;
  readonly ownerNames: Record<string, string>;
}

function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const days = Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  const w = Math.floor(days / 7);
  return w < 5 ? `${w}w ago` : `${Math.floor(days / 30)}mo ago`;
}

function inNetworkSince(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

export function TalentTriageDrawer({
  talent,
  index,
  total,
  onClose,
  onPrev,
  onNext,
  onAddToReq,
  ownerNames,
}: DrawerProps) {
  const [pipelines, setPipelines] = useState<readonly PipelineView[]>([]);
  const [activities, setActivities] = useState<readonly ActivityView[]>([]);
  const [loading, setLoading] = useState(false);
  const [pipeError, setPipeError] = useState(false);
  const [actError, setActError] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const talentId = talent?.id ?? null;

  useEffect(() => {
    if (talentId === null) return;
    let cancelled = false;
    setLoading(true);
    setPipeError(false);
    setActError(false);
    setPipelines([]);
    setActivities([]);
    void Promise.allSettled([
      listPipelinesForTalent(talentId),
      listActivities('talent_record', talentId),
    ]).then(([p, a]) => {
      if (cancelled) return;
      if (p.status === 'fulfilled') setPipelines(p.value.items);
      else setPipeError(true);
      if (a.status === 'fulfilled') setActivities(a.value.items);
      else setActError(true);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [talentId]);

  // a11y: capture the trigger, move focus into the drawer on open, restore on
  // close; Esc closes; Tab is trapped within the drawer (dialog semantics).
  useEffect(() => {
    if (talentId === null) return;
    restoreRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    headingRef.current?.focus();
    const toRestore = restoreRef.current;
    return () => toRestore?.focus();
  }, [talentId]);

  useEffect(() => {
    if (talentId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = asideRef.current;
      if (root === null) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
  }, [talentId, onClose]);

  if (talent === null) return null;
  const owner = talent.owner_id ? (ownerNames[talent.owner_id] ?? null) : null;

  return (
    <aside
      ref={asideRef}
      className="rc-drawer rc-drawer--open"
      role="dialog"
      aria-modal="false"
      aria-label={`${fullName(talent)} — triage`}
    >
      <div className="rc-drawer__hd">
        <button
          type="button"
          className="rc-drawer__nav"
          aria-label="Previous talent"
          onClick={onPrev}
          disabled={index <= 0}
        >
          <Icons.IconChevronLeft />
        </button>
        <button
          type="button"
          className="rc-drawer__nav"
          aria-label="Next talent"
          onClick={onNext}
          disabled={index >= total - 1}
        >
          <Icons.IconChevronRight />
        </button>
        <span className="rc-drawer__pos num">
          {index + 1} of {total}
        </span>
        <button
          type="button"
          className="rc-drawer__x"
          aria-label="Close"
          onClick={onClose}
        >
          <Icons.IconX />
        </button>
      </div>

      <div className="rc-drawer__body">
        <div className="rc-drawer__id">
          <Avatar name={fullName(talent)} size="lg" />
          <div>
            <h3 ref={headingRef} tabIndex={-1}>
              {fullName(talent)}
              {talent.is_hot ? (
                <Icons.IconFlame className="rc-drawer__flame" />
              ) : null}
            </h3>
            <div className="rc-drawer__rl">
              {[talent.current_employer, locationOf(talent)]
                .filter((s) => s && s !== '—')
                .join(' · ') || 'Talent'}
            </div>
          </div>
        </div>

        <div className="rc-drawer__act">
          <Link to={`/talent/${talent.id}`} className="rc-drawer__act-full">
            <Button variant="primary">
              <Icons.IconOpen /> Open full profile
            </Button>
          </Link>
          <Button variant="secondary" onClick={() => onAddToReq(talent)}>
            <Icons.IconBriefcase /> Add to req
          </Button>
        </div>

        <section className="rc-drawer__sec">
          <h4>Key facts</h4>
          <div className="rc-kv">
            <span className="rc-kv__k">Stated rate</span>
            <span className="rc-kv__v num">{statedRate(talent)}</span>
          </div>
          <div className="rc-kv">
            <span className="rc-kv__k">Availability</span>
            <span className="rc-kv__v">
              {talent.availability_status === null
                ? '—'
                : AVAILABILITY_LABELS[talent.availability_status]}
            </span>
          </div>
          <div className="rc-kv">
            <span className="rc-kv__k">Engagement</span>
            <span className="rc-kv__v">
              {talent.engagement_type === null
                ? '—'
                : ENGAGEMENT_LABELS[talent.engagement_type]}
            </span>
          </div>
          <div className="rc-kv">
            <span className="rc-kv__k">Source</span>
            <span className="rc-kv__v">{talent.source ?? '—'}</span>
          </div>
          <div className="rc-kv">
            <span className="rc-kv__k">Owner</span>
            <span className="rc-kv__v">{owner ?? '—'}</span>
          </div>
          <div className="rc-kv">
            <span className="rc-kv__k">In your network since</span>
            <span className="rc-kv__v">{inNetworkSince(talent.created_at)}</span>
          </div>
          <p className="rc-drawer__note">
            Work authorization isn’t modelled on the talent record yet (carry).
          </p>
        </section>

        <section className="rc-drawer__sec">
          <h4>Skills</h4>
          {skillsOf(talent).length === 0 ? (
            <p className="rc-drawer__empty">No skills recorded.</p>
          ) : (
            <div className="rc-drawer__skills">
              {skillsOf(talent).map((s) => (
                <Tag key={s}>{s}</Tag>
              ))}
            </div>
          )}
        </section>

        <section className="rc-drawer__sec">
          <h4>In pipeline</h4>
          {loading ? (
            <p className="rc-drawer__empty">Loading…</p>
          ) : pipeError ? (
            <p className="rc-drawer__empty">Couldn’t load pipelines.</p>
          ) : pipelines.length === 0 ? (
            <p className="rc-drawer__empty">Not in any pipeline.</p>
          ) : (
            pipelines.map((p) => (
              <div key={p.id} className="rc-drawer__pipe">
                <span className="rc-drawer__pipe-req mono">{p.requisition_id}</span>
                <StagePill status={p.status} />
              </div>
            ))
          )}
        </section>

        <section className="rc-drawer__sec">
          <h4>Recent activity</h4>
          {loading ? (
            <p className="rc-drawer__empty">Loading…</p>
          ) : actError ? (
            <p className="rc-drawer__empty">Couldn’t load activity.</p>
          ) : activities.length === 0 ? (
            <p className="rc-drawer__empty">No recent activity.</p>
          ) : (
            <ul className="rc-drawer__feed">
              {activities.slice(0, 6).map((a) => (
                <li key={a.id}>
                  <span className="rc-drawer__feed-t">
                    {a.notes ?? a.type}
                  </span>
                  <span className="rc-drawer__feed-w">{ago(a.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rc-drawer__sec">
          <ReservedSeam title="Match insight" tag="Integrates with Core later">
            When Aramo Core is connected, its reasoning for this talent — the
            evidence behind a recommendation, never a number — appears here.
          </ReservedSeam>
        </section>
      </div>
    </aside>
  );
}
