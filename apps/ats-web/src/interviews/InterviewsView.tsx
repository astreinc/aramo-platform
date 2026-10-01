import { Button, InlineAlert } from '@aramo/fe-foundation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { EmptyState, safeErrorMessage } from '../ui';

import {
  addDays,
  dayHeading,
  INTERVIEW_STATE_LABEL,
  requisitionLabel,
  startOfWeek,
  timeLabel,
} from './interview-format';
import { getInterviewCalendar, type InterviewCalendarRow } from './interviews-api';

// The recruiter interview CALENDAR workspace (route `/interviews`, Calendar/Interview
// §15). A READ projection of GET /v1/interviews: the FE renders what the backend already
// composed and never re-derives interview meaning. Two views — Week (7-day window with
// previous/today/next navigation) and Agenda (next 30 days) — both day-grouped, earliest
// first. Interview cards open the authoritative interview detail. Loading / empty / error
// are all handled honestly.

type Mode = 'week' | 'agenda';

interface DayGroup {
  readonly day: string;
  readonly items: readonly InterviewCalendarRow[];
}

export function InterviewsView() {
  // A deep-link from a Talent×Requisition journey (Calendar/Interview §19) filters the
  // calendar to that grain; in that mode the view opens in Agenda over a wide window so
  // the interview shows regardless of which week it falls in.
  const [searchParams] = useSearchParams();
  const requisitionId = searchParams.get('requisition_id') ?? undefined;
  const talentId = searchParams.get('talent_id') ?? undefined;
  const filtered = requisitionId !== undefined || talentId !== undefined;

  const [mode, setMode] = useState<Mode>(filtered ? 'agenda' : 'week');
  const [anchor, setAnchor] = useState<Date>(() => startOfWeek(new Date()));
  const [rows, setRows] = useState<readonly InterviewCalendarRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const window = useMemo(() => {
    if (mode === 'week') {
      const from = startOfWeek(anchor);
      return {
        from,
        to: addDays(from, 7),
        label: `Week of ${from.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`,
      };
    }
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    if (filtered) {
      return {
        from: addDays(base, -30),
        to: addDays(base, 90),
        label: 'Scheduled interviews',
      };
    }
    return { from: base, to: addDays(base, 30), label: 'Next 30 days' };
  }, [mode, anchor, filtered]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getInterviewCalendar({
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      ...(requisitionId === undefined ? {} : { requisition_id: requisitionId }),
      ...(talentId === undefined ? {} : { talent_id: talentId }),
    })
      .then((v) => setRows(v.interviews))
      .catch((e) =>
        setError(safeErrorMessage(e, 'Could not load interviews right now.')),
      )
      .finally(() => setLoading(false));
  }, [window.from, window.to, requisitionId, talentId]);
  useEffect(() => load(), [load]);

  const groups = useMemo<readonly DayGroup[]>(() => {
    if (rows === null) return [];
    const byDay = new Map<string, InterviewCalendarRow[]>();
    for (const r of rows) {
      const key = dayHeading(r.scheduled_at);
      const list = byDay.get(key) ?? [];
      list.push(r);
      byDay.set(key, list);
    }
    return [...byDay.entries()].map(([day, items]) => ({ day, items }));
  }, [rows]);

  return (
    <section className="rc-page">
      <header className="rc-page-head">
        <h1>Interviews</h1>
        <div className="rc-toolbar">
          <div role="tablist" aria-label="Calendar view">
            <Button
              unstyled
              className={mode === 'week' ? 'rc-tab rc-tab-active' : 'rc-tab'}
              aria-pressed={mode === 'week'}
              onClick={() => setMode('week')}
            >
              Week
            </Button>
            <Button
              unstyled
              className={mode === 'agenda' ? 'rc-tab rc-tab-active' : 'rc-tab'}
              aria-pressed={mode === 'agenda'}
              onClick={() => setMode('agenda')}
            >
              Agenda
            </Button>
          </div>
          {mode === 'week' ? (
            <div className="rc-nav" role="group" aria-label="Week navigation">
              <Button
                unstyled
                className="rc-link-action"
                onClick={() => setAnchor((a) => addDays(startOfWeek(a), -7))}
              >
                Previous
              </Button>
              <Button
                unstyled
                className="rc-link-action"
                onClick={() => setAnchor(startOfWeek(new Date()))}
              >
                Today
              </Button>
              <Button
                unstyled
                className="rc-link-action"
                onClick={() => setAnchor((a) => addDays(startOfWeek(a), 7))}
              >
                Next
              </Button>
            </div>
          ) : null}
        </div>
        <p className="rc-muted-line">{window.label}</p>
      </header>

      {loading && rows === null ? (
        <p className="rc-muted-line">Loading interviews…</p>
      ) : error !== null && rows === null ? (
        <InlineAlert variant="error">
          {error}{' '}
          <Button unstyled className="rc-link-action" onClick={load}>
            Retry
          </Button>
        </InlineAlert>
      ) : groups.length === 0 ? (
        <EmptyState
          title="No interviews"
          message="No interviews are scheduled in this range."
        />
      ) : (
        <div className="rc-interview-groups">
          {groups.map((g) => (
            <div key={g.day} className="rc-interview-day">
              <h2 className="rc-interview-day-head">{g.day}</h2>
              <ul className="rc-interview-list">
                {g.items.map((iv) => (
                  <li key={iv.id} className="rc-interview-card">
                    <Link to={`/interviews/${iv.id}`} className="rc-interview-link">
                      <span className="rc-interview-time">
                        {timeLabel(iv.scheduled_at)}
                      </span>
                      <span className="rc-interview-talent">
                        {iv.talent_name ?? 'Talent'}
                      </span>
                      <span className="rc-interview-req">
                        {requisitionLabel(
                          iv.requisition_number,
                          iv.requisition_title,
                          iv.company_name,
                        )}
                      </span>
                      <span className="rc-interview-meta">
                        Round {iv.round} · {iv.interview_type}
                      </span>
                      <span
                        className={`rc-interview-state rc-state-${iv.state.toLowerCase()}`}
                      >
                        {INTERVIEW_STATE_LABEL[iv.state]}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
