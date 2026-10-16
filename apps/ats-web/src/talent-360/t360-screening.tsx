// Talent 360 — Technical Screening (§9): read-only history across requisitions,
// composed from the EXISTING INC-3 screening reads (no new endpoint):
//   • GET /v1/talent-records/:id/screening-sessions  → one row per session
//   • GET /v1/screening-sessions/:id                 → planned-question count
// plus the talent's active opportunities (from the Talent 360 read) for the
// "Not prepared yet" rows. Status is the session's own state, never derived.
// Per ARAMO-TIP-E2E-INC-3 ("Screening assigns no trust number and no band") and
// the footer rule, NO overall level/rating pill is shown here.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  getScreeningSession,
  listScreeningSessions,
  type ScreeningSession,
} from '../technical-screening/technical-screening-api';
import { resolveUserNames } from '../users/users-api';

import { shortDate } from './t360-model';
import type { Talent360View as Model } from './talent-360-types';

interface ReqInfo {
  readonly code: string;
  readonly client: string | null;
}

interface Row {
  readonly key: string;
  readonly req: ReqInfo | null;
  readonly meta: string;
  readonly pill: { label: string; tone: string };
  readonly action: { label: string; to: string };
}

type Load =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; sessions: readonly ScreeningSession[]; questions: ReadonlyMap<string, number>; names: Record<string, string> };

// The session's lifecycle state → recruiter-facing pill. A DRAFT with nothing
// planned yet reads "Not started"; one with planned questions "In progress".
function pillFor(s: ScreeningSession, planned: number): { label: string; tone: string } {
  if (s.state === 'CONFIRMED') return { label: 'Complete', tone: 't360-tone--green' };
  return planned > 0 ? { label: 'In progress', tone: 't360-tone--blue' } : { label: 'Not started', tone: 't360-tone--grey' };
}

export function ScreeningSection({
  model,
  talentId,
  canScreen,
  firstName,
}: {
  model: Model;
  talentId: string;
  canScreen: boolean;
  firstName: string;
}): JSX.Element {
  const [load, setLoad] = useState<Load>({ status: 'loading' });

  useEffect(() => {
    if (!canScreen) return undefined;
    let cancelled = false;
    setLoad({ status: 'loading' });
    (async () => {
      const { items } = await listScreeningSessions(talentId);
      const sessions = items.filter((s) => s.state !== 'VOIDED');
      const details = await Promise.all(
        sessions.slice(0, 20).map((s) =>
          getScreeningSession(s.id)
            .then((d) => [s.id, d.questions.filter((q) => q.status === 'SELECTED').length] as const)
            .catch(() => [s.id, 0] as const),
        ),
      );
      const ids = [...new Set(sessions.map((s) => s.created_by_actor_id))];
      const names = ids.length > 0 ? await resolveUserNames(ids).catch(() => ({})) : {};
      if (!cancelled) setLoad({ status: 'ready', sessions, questions: new Map(details), names });
    })().catch(() => {
      if (!cancelled) setLoad({ status: 'error' });
    });
    return () => {
      cancelled = true;
    };
  }, [talentId, canScreen]);

  const reqs = new Map<string, ReqInfo>();
  for (const o of [...(model.opportunities?.active ?? []), ...(model.opportunities?.closed ?? [])]) {
    reqs.set(o.requisition_id, { code: o.requisition_code, client: o.client_name });
  }
  const workspace = `/talent/${talentId}/screening`;

  const rows: Row[] = [];
  if (load.status === 'ready') {
    const sorted = [...load.sessions].sort((a, b) => b.created_at.localeCompare(a.created_at));
    for (const s of sorted) {
      const planned = load.questions.get(s.id) ?? 0;
      const when = shortDate(s.confirmed_at ?? s.created_at);
      const who = load.names[s.created_by_actor_id] ?? null;
      rows.push({
        key: s.id,
        req: s.requisition_id !== null ? (reqs.get(s.requisition_id) ?? null) : null,
        meta: [when, planned > 0 ? `${planned} question${planned === 1 ? '' : 's'}` : null, who].filter(Boolean).join(' · '),
        pill: pillFor(s, planned),
        action: s.state === 'CONFIRMED' ? { label: 'View findings ↗', to: workspace } : { label: 'Continue ↗', to: workspace },
      });
    }
    // Active opportunities with no screening yet → "Not prepared yet".
    const screened = new Set(load.sessions.map((s) => s.requisition_id).filter((x): x is string => x !== null));
    for (const o of model.opportunities?.active ?? []) {
      if (screened.has(o.requisition_id)) continue;
      rows.push({
        key: `req:${o.requisition_id}`,
        req: { code: o.requisition_code, client: o.client_name },
        meta: 'Not prepared yet',
        pill: { label: 'Not started', tone: 't360-tone--grey' },
        action: { label: `Prepare in ${o.requisition_code} ↗`, to: workspace },
      });
    }
  }

  return (
    <div className="t360-card t360-card--sect" data-testid="t360-ts">
      <div className="t360-sect__title">Technical Screening</div>
      <div className="t360-caption t360-caption--trust">
        Every technical screening {firstName} has had, across all requisitions. Open one to see the findings, or prepare a new one for an active requisition.
      </div>
      {!canScreen ? (
        <div className="t360-empty t360-empty--rowtop">You don’t have access to technical screening.</div>
      ) : load.status === 'loading' ? (
        <div className="t360-empty t360-empty--rowtop">Loading screenings…</div>
      ) : load.status === 'error' ? (
        <div className="t360-empty t360-empty--rowtop">Screenings couldn’t be loaded. Try again shortly.</div>
      ) : rows.length === 0 ? (
        <div className="t360-empty t360-empty--rowtop">No technical screenings yet.</div>
      ) : (
        rows.map((r) => (
          <div key={r.key} className="t360-tsrow" data-testid="t360-ts-row">
            <span className="t360-min0 t360-grow">
              <span className="t360-tsrow__head">
                {r.req !== null ? <span className="t360-mono t360-tsrow__req">{r.req.code}</span> : null}
                <b>{r.req?.client ?? (r.req === null ? 'No requisition' : '')}</b>
              </span>
              <span className="t360-tsrow__meta">{r.meta}</span>
            </span>
            <span className={`t360-pill ${r.pill.tone}`}>{r.pill.label}</span>
            <Link className="t360-btn t360-btn--neutral t360-btn--sm" to={r.action.to}>
              {r.action.label}
            </Link>
          </div>
        ))
      )}
      <div className="t360-tsfoot">Findings are recruiter-attested. Aramo never qualifies, rejects or ranks.</div>
    </div>
  );
}
