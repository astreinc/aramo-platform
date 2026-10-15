import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { InlineAlert } from '@aramo/fe-foundation';

import { formatDate } from '../format/date';
import { PIPELINE_STATUS_LABELS } from '../pipeline/types';

import { listActivities } from './activity-api';
import { formatActivityNote, parsePipelineTransition } from './activity-note-format';
import { isRedacted, redactedNoteLabel } from './redaction';
import { timelineErrorMessage } from './error-messages';
import { NOTE_CATEGORY_LABELS, type ActivityView } from './types';

interface ActivityTimelineProps {
  readonly requisitionId: string;
  // Pipeline IDs visible on the kanban for this req — the per-pipeline
  // transition activities are fetched in parallel (Q6 branch (c) — the
  // auto pipeline_status_change emits with subject_type='pipeline').
  // A BE aggregation endpoint would collapse the N+1; filed as a
  // follow-up.
  readonly pipelineIds: readonly string[];
  // A bump counter the parent increments to force a refetch (after a
  // transition or a logged note).
  readonly refreshKey?: number;
  // Display names the page already resolved: Talent per pipeline id (pipeline
  // rows) and author per user id. Missing entries are simply omitted.
  readonly talentNameByPipelineId?: Readonly<Record<string, string>>;
  readonly userNames?: Readonly<Record<string, string>>;
  // Card heading + an optional action rendered in the card head (prototype:
  // the title sits INSIDE the card, like every other requisition tab card).
  readonly title?: string;
  readonly headerAction?: ReactNode;
}

const NO_NAMES: Readonly<Record<string, string>> = {};

export function ActivityTimeline({
  requisitionId,
  pipelineIds,
  refreshKey,
  talentNameByPipelineId = NO_NAMES,
  userNames = NO_NAMES,
  title,
  headerAction,
}: ActivityTimelineProps) {
  const [items, setItems] = useState<readonly ActivityView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const reqReq = listActivities('requisition', requisitionId);
      const pipelineReqs = pipelineIds.map((id) => listActivities('pipeline', id));
      const [reqResult, ...pipelineResults] = await Promise.allSettled([
        reqReq,
        ...pipelineReqs,
      ]);
      const merged: ActivityView[] = [];
      if (reqResult.status === 'fulfilled') {
        merged.push(...reqResult.value.items);
      }
      for (const r of pipelineResults) {
        if (r.status === 'fulfilled') {
          merged.push(...r.value.items);
        }
      }
      merged.sort((a, b) => b.created_at.localeCompare(a.created_at));
      setItems(merged);
    } catch (err) {
      setError(timelineErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [requisitionId, pipelineIds]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  let content: ReactNode;
  if (loading) {
    content = <p className="rc-tl__empty">Loading activity…</p>;
  } else if (error !== null) {
    content = <InlineAlert variant="error">{error}</InlineAlert>;
  } else if (items.length === 0) {
    content = <p className="rc-tl__empty timeline__empty">No activity yet.</p>;
  } else {
    content = items.map((a) => {
      const row = describeActivity(a, talentNameByPipelineId, userNames);
      return (
        <div key={a.id} className="rc-tl__row">
          <span className={`rc-act__dot rc-act__dot--${row.tone}`} aria-hidden="true" />
          <span className="rc-tl__body">
            <span className="rc-tl__tag">{row.domain}</span>
            <b>{row.what}</b>
            {row.detail !== '' && <span className="rc-tl__detail"> {row.detail}</span>}
          </span>
          <time className="rc-tl__when" dateTime={a.created_at} title={formatDate(a.created_at)}>
            {ago(a.created_at)}
          </time>
        </div>
      );
    });
  }

  // One card, compact rows (prototype "Activity — one timeline, every
  // lifecycle"): dot · domain tag · headline · detail · relative time.
  return (
    <div className="rc-card rc-tl">
      {title !== undefined && (
        <div className="rc-tl__head">
          <h2>{title}</h2>
          {headerAction !== undefined && <div className="rc-tl__actions">{headerAction}</div>}
        </div>
      )}
      {content}
    </div>
  );
}

interface ActivityRowModel {
  readonly domain: string;
  readonly what: string;
  readonly detail: string;
  readonly tone: 'ok' | 'brand' | 'mute';
}

// Presentation only: every part is read from the activity row plus the names the
// page already resolved (talent per pipeline, author per user id). Unresolved
// names are omitted, never replaced by an id.
export function describeActivity(
  a: ActivityView,
  talentNameByPipelineId: Readonly<Record<string, string>>,
  userNames: Readonly<Record<string, string>>,
): ActivityRowModel {
  const talent =
    a.subject_type === 'pipeline' && a.subject_id !== null
      ? (talentNameByPipelineId[a.subject_id] ?? null)
      : null;
  const author = a.created_by_id !== null ? (userNames[a.created_by_id] ?? null) : null;
  const redacted = isRedacted(a);
  const notes = !redacted && a.notes !== null && a.notes.trim() !== '' ? a.notes.trim() : null;

  let what = labelFor(a.type);
  let tone: ActivityRowModel['tone'] = a.type === 'note' ? 'mute' : 'ok';
  let body: string | null = notes;
  let verb = 'by';
  if (a.type === 'pipeline_status_change' && notes !== null) {
    const t = parsePipelineTransition(notes);
    if (t !== null) {
      what = PIPELINE_STATUS_LABELS[t.to];
      body = t.note;
      verb = t.to === 'voided' ? 'removed by' : 'moved by';
      tone =
        t.to === 'qualified' || t.to === 'completed'
          ? 'brand'
          : t.to === 'voided' || t.to === 'not_in_consideration'
            ? 'mute'
            : 'ok';
    } else {
      body = formatActivityNote(notes);
    }
  } else if (a.type === 'note' && a.category !== null) {
    what = NOTE_CATEGORY_LABELS[a.category];
  }
  const parts = [
    talent,
    author !== null ? `${verb} ${author}` : null,
    redacted ? redactedNoteLabel(a.redacted_at, null) : body,
  ].filter((x): x is string => x !== null && x !== '');
  return { domain: domainFor(a.subject_type), what, detail: parts.join(' · '), tone };
}

function domainFor(subjectType: string | null): string {
  switch (subjectType) {
    case 'pipeline':
      return 'PIPELINE';
    case 'requisition':
      return 'REQUISITION';
    case 'talent_record':
      return 'TALENT';
    case 'contact':
      return 'CONTACT';
    default:
      return 'ACTIVITY';
  }
}

// "today" / "yesterday" / "3d ago" / "2w ago" / "4mo ago" — full date on hover.
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

function labelFor(type: ActivityView['type']): string {
  switch (type) {
    case 'pipeline_status_change':
      return 'Stage change';
    case 'note':
      return 'Note';
    case 'call':
      return 'Call logged';
    case 'email_logged':
      return 'Email logged';
  }
}
