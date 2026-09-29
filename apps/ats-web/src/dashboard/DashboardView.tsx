import { Button, InlineAlert } from '@aramo/fe-foundation';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useMe } from '../shell/me-api';
import { DataTable, EmptyState, safeErrorMessage, type TableColumn } from '../ui';

import { getMyDesk } from './my-desk-api';
import type {
  DeskItemKind,
  DeskPriorityItemView,
  DeskRequisitionRowView,
  DeskUrgency,
  MyDeskView,
} from './my-desk-types';

// My Desk — the ats-web recruiter command center (route `/`). A READ/WORK
// PROJECTION of GET /v1/my-desk: the FE renders what the backend already
// derived and NEVER re-derives business meaning (urgency + ordering are
// server-authoritative; every card/tab count is derived from the returned
// arrays, so a badge can never drift from its list). FACTS-ONLY (R10): no
// verdict, no fabricated confirmation/channel/ownership, no snooze — those are
// backend Increment-2. The queue answers, per row: why · how urgent · what next.

const KIND: Record<DeskItemKind, { label: string; tone: string }> = {
  follow_up: { label: 'Follow-up', tone: 'blue' },
  client: { label: 'Client', tone: 'teal' },
  rtr: { label: 'RTR', tone: 'amber' },
  submittal: { label: 'Submittal', tone: 'green' },
  engagement: { label: 'Engagement', tone: 'purple' },
  task: { label: 'Task', tone: 'grey' },
};

// kind → queue tab bucket (Follow-ups groups follow_up+client; Submittals groups
// submittal+rtr — mirrors the prototype's tab folding).
const KIND_TAB: Record<DeskItemKind, TabKey> = {
  follow_up: 'follow',
  client: 'follow',
  rtr: 'submit',
  submittal: 'submit',
  engagement: 'eng',
  task: 'task',
};

type TabKey = 'all' | 'overdue' | 'follow' | 'submit' | 'eng' | 'task';
const TABS: readonly { key: TabKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'follow', label: 'Follow-ups' },
  { key: 'submit', label: 'Submittals' },
  { key: 'eng', label: 'Engagement' },
  { key: 'task', label: 'Tasks' },
];

const SECTIONS: readonly { key: DeskUrgency; label: string }[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Due today' },
  { key: 'upcoming', label: 'Coming up' },
];

export function DashboardView() {
  const me = useMe();
  const [desk, setDesk] = useState<MyDeskView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('all');
  const [scope, setScope] = useState<'mine' | 'team'>('mine');

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getMyDesk()
      .then((v) => setDesk(v))
      .catch((e) => setError(safeErrorMessage(e, 'Could not load your desk right now.')))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => load(), [load]);

  if (loading && desk === null) {
    return <p className="rc-muted-line">Loading your desk…</p>;
  }
  if (error !== null && desk === null) {
    return (
      <InlineAlert variant="error">
        {error}{' '}
        <Button unstyled className="rc-link-action" onClick={load}>
          Retry
        </Button>
      </InlineAlert>
    );
  }
  if (desk === null) return null;

  // --- everything below is derived from the returned arrays (no drift) ---
  const overdue = desk.priority_items.filter((i) => i.urgency === 'overdue').length;
  const dueToday = desk.priority_items.filter((i) => i.urgency === 'today').length;
  const ivCount = desk.interviews_today.length;
  const awaitingCount = desk.awaiting_client.length;
  const excCount = desk.exceptions.length;
  const oldestWaiting = desk.awaiting_client.reduce((m, w) => Math.max(m, w.waiting_days), 0);

  const headline = `${overdue} overdue · ${dueToday} due today · ${ivCount} interviews · ${excCount} exceptions`;

  const inTab = desk.priority_items.filter((i) =>
    tab === 'all'
      ? true
      : tab === 'overdue'
        ? i.urgency === 'overdue'
        : KIND_TAB[i.kind] === tab,
  );
  const groups = SECTIONS.map((s) => ({
    ...s,
    items: inTab.filter((i) => i.urgency === s.key),
  })).filter((g) => g.items.length > 0);

  const tabCount = (k: TabKey): number =>
    k === 'all'
      ? desk.priority_items.length
      : k === 'overdue'
        ? overdue
        : desk.priority_items.filter((i) => KIND_TAB[i.kind] === k).length;

  const firstName = me?.user?.display_name?.trim().split(/\s+/)[0] ?? '';

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const cards: readonly {
    label: string;
    n: number;
    sub: string;
    hot?: boolean;
    onClick: () => void;
  }[] = [
    { label: 'Overdue', n: overdue, sub: 'Past their due date', hot: overdue > 0, onClick: () => setTab('overdue') },
    { label: 'Due today', n: dueToday, sub: 'Follow-ups, RTRs, submittals', onClick: () => setTab('all') },
    { label: 'Interviews today', n: ivCount, sub: 'Scheduled today', onClick: () => scrollTo('desk-interviews') },
    { label: 'Awaiting client', n: awaitingCount, sub: awaitingCount > 0 ? `Oldest ${oldestWaiting}d` : 'None waiting', onClick: () => scrollTo('desk-awaiting') },
    { label: 'Exceptions', n: excCount, sub: 'Stuck or broken', hot: excCount > 0, onClick: () => scrollTo('desk-exceptions') },
  ];

  const reqColumns: readonly TableColumn<DeskRequisitionRowView>[] = [
    {
      key: 'req',
      header: 'Requisition',
      render: (r) => (
        <Link to={`/requisitions/${r.id}`} className="rc-link-strong">
          <span className="rc-desk-reqcell">
            <span className="rc-desk-reqcell__t">{r.title}</span>
            <span className="rc-desk-reqcell__s">
              <span className="num">{r.code}</span>
              {r.client_name !== null ? ` · ${r.client_name}` : ''} · {r.days_open}d open
            </span>
          </span>
        </Link>
      ),
    },
    { key: 'status', header: 'Status', render: (r) => <span className="rc-desk-status">{r.status}</span> },
    { key: 'pipeline', header: 'Pipeline', align: 'right', render: (r) => <span className="num">{r.pipeline_count}</span> },
    { key: 'qualified', header: 'Qualified', align: 'right', render: (r) => <span className="num">{r.qualified_count}</span> },
    { key: 'with_client', header: 'With client', align: 'right', render: (r) => <span className="num rc-muted">{r.with_client_count}</span> },
    { key: 'offer', header: 'Offer', align: 'right', render: (r) => <span className="num rc-muted">{r.offer_count}</span> },
    { key: 'started', header: 'Started', align: 'right', render: (r) => <span className="num rc-muted">{r.started_count}</span> },
    { key: 'signal', header: 'Signal', render: (r) => <span className="rc-desk-signal">{r.signal}</span> },
  ];

  return (
    <section className="rc-desk">
      <div className="rc-desk-head">
        <div className="rc-desk-head__lead">
          <div className="rc-desk-date">{formatDeskDate(desk.server_date)}</div>
          <h1 className="rc-h1">
            {timeGreeting()}
            {firstName !== '' ? `, ${firstName}` : ''}
          </h1>
          <div className="rc-desk-headline">{headline}</div>
        </div>
        <div className="rc-desk-head__actions">
          <span className="rc-desk-scope" role="tablist" aria-label="Work scope">
            <Button
              unstyled
              role="tab"
              aria-selected={scope === 'mine'}
              className={`rc-desk-scope__btn${scope === 'mine' ? ' is-on' : ''}`}
              onClick={() => setScope('mine')}
            >
              My work
            </Button>
            <Button
              unstyled
              className="rc-desk-scope__btn"
              disabled
              title="Team view is for Lead recruiters — coming soon"
            >
              My team
            </Button>
          </span>
          <Link to="/requisitions/new" className="rc-desk-btn">
            Import client requisition
          </Link>
          <Link to="/talent/new" className="rc-desk-btn rc-desk-btn--primary">
            Add talent
          </Link>
        </div>
      </div>

      <div className="rc-desk-cards">
        {cards.map((c) => (
          <Button
            key={c.label}
            unstyled
            className={`rc-desk-card${c.hot === true ? ' rc-desk-card--hot' : ''}`}
            onClick={c.onClick}
          >
            <span className="rc-desk-card__label">{c.label}</span>
            <span className="rc-desk-card__n num">{c.n}</span>
            <span className="rc-desk-card__sub">{c.sub}</span>
          </Button>
        ))}
      </div>

      <div className="rc-desk-split">
        <section className="rc-desk-col">
          <div className="rc-card">
            <div className="rc-card__head">
              <div>
                <h2>Priority queue</h2>
                <div className="rc-desk-subtle">
                  Next actions across your requisitions, ranked by urgency.
                </div>
              </div>
              <span className="rc-desk-count">{desk.priority_items.length} open</span>
            </div>
            <div className="rc-desk-tabs" role="tablist" aria-label="Priority queue filter">
              {TABS.map((t) => (
                <Button
                  key={t.key}
                  unstyled
                  role="tab"
                  aria-selected={tab === t.key}
                  className={`rc-desk-tab${tab === t.key ? ' is-on' : ''}`}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                  <span className="rc-desk-tab__n num">{tabCount(t.key)}</span>
                </Button>
              ))}
            </div>
            {groups.length === 0 ? (
              <EmptyState title="You're caught up" message="Nothing needs your attention in this view." />
            ) : (
              groups.map((g) => (
                <div key={g.key}>
                  <div className={`rc-desk-group rc-desk-group--${g.key}`}>
                    {g.label} · {g.items.length}
                  </div>
                  {g.items.map((item) => (
                    <QueueRow key={item.id} item={item} />
                  ))}
                </div>
              ))
            )}
            <div className="rc-desk-note">
              Items appear here automatically from pipeline state, engagement,
              client feedback and tasks.
            </div>
          </div>

          <div className="rc-card">
            <div className="rc-card__head">
              <div>
                <h2>My requisitions</h2>
                <div className="rc-desk-subtle">
                  Where your talent sits on each requisition you're assigned to.
                </div>
              </div>
              <Link to="/requisitions" className="rc-card__head-more">
                All requisitions
              </Link>
            </div>
            <DataTable<DeskRequisitionRowView>
              columns={reqColumns}
              rows={[...desk.requisitions]}
              rowKey={(r) => r.id}
              emptyMessage="No requisitions assigned to you yet."
            />
          </div>
        </section>

        <aside className="rc-desk-col rc-desk-col--rail">
          <div className="rc-card" id="desk-interviews">
            <div className="rc-card__head">
              <h2>Today's interviews</h2>
              <span className="rc-desk-count">{ivCount} scheduled</span>
            </div>
            {ivCount === 0 ? (
              <p className="rc-empty">No interviews scheduled today.</p>
            ) : (
              desk.interviews_today.map((iv) => (
                <div key={iv.id} className="rc-desk-iv">
                  <span className="rc-desk-iv__time num">{formatTime(iv.scheduled_at)}</span>
                  <span className="rc-desk-iv__body">
                    <span className="rc-desk-iv__who">{iv.talent_name ?? 'Talent'}</span>
                    <span className="rc-desk-iv__what">
                      {interviewLabel(iv.interview_type)}
                      {iv.round !== null ? ` · Round ${iv.round}` : ''}
                      {iv.requisition_label !== null ? ` · ${iv.requisition_label}` : ''}
                    </span>
                  </span>
                </div>
              ))
            )}
          </div>

          <div className="rc-card" id="desk-exceptions">
            <div className="rc-card__head">
              <div>
                <h2>Exceptions</h2>
                <div className="rc-desk-subtle">Things that are stuck or broken.</div>
              </div>
            </div>
            {excCount === 0 ? (
              <p className="rc-empty">No blocked items need your attention.</p>
            ) : (
              desk.exceptions.map((x) => (
                <div key={x.id} className="rc-desk-exc">
                  <span className="rc-desk-exc__head">
                    <span className={`rc-desk-dot rc-desk-dot--${x.severity}`} aria-hidden="true" />
                    <span className="rc-desk-exc__title">{x.title}</span>
                  </span>
                  <span className="rc-desk-exc__body">{x.body}</span>
                  {x.requisition_id !== null ? (
                    <Link to={`/requisitions/${x.requisition_id}`} className="rc-desk-exc__link">
                      Open requisition
                    </Link>
                  ) : x.owner_label !== null ? (
                    <span className="rc-desk-exc__owner">{x.owner_label}</span>
                  ) : null}
                </div>
              ))
            )}
          </div>

          <div className="rc-card" id="desk-awaiting">
            <div className="rc-card__head">
              <div>
                <h2>Awaiting client</h2>
                <div className="rc-desk-subtle">
                  Submittals with no client decision yet, oldest first.
                </div>
              </div>
            </div>
            {awaitingCount === 0 ? (
              <p className="rc-empty">Nothing is waiting on a client decision.</p>
            ) : (
              desk.awaiting_client.map((w) => (
                <div key={w.id} className="rc-desk-await">
                  <span className="rc-desk-await__body">
                    <span className="rc-desk-await__who">{w.talent_name ?? 'Talent'}</span>
                    <span className="rc-desk-await__what">
                      {w.requisition_label !== null ? `${w.requisition_label} · ` : ''}
                      {w.reason}
                    </span>
                  </span>
                  <span className={`rc-desk-age${w.waiting_days >= 7 ? ' rc-desk-age--old' : ''}`}>
                    {w.waiting_days}d
                  </span>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

function QueueRow({ item }: { item: DeskPriorityItemView }) {
  const kind = KIND[item.kind];
  const who = item.talent_name ?? item.label;
  const whoHref =
    item.talent_id !== null
      ? `/talent/${item.talent_id}`
      : item.requisition_id !== null
        ? `/requisitions/${item.requisition_id}`
        : null;
  return (
    <div className="rc-desk-row">
      <span
        className={`rc-desk-ic rc-desk-kind--${kind.tone}`}
        title={kind.label}
        aria-hidden="true"
      >
        {kind.label.charAt(0)}
      </span>
      <span className="rc-desk-row__body">
        <span className="rc-desk-row__top">
          {whoHref !== null ? (
            <Link to={whoHref} className="rc-desk-row__who">
              {who}
            </Link>
          ) : (
            <span className="rc-desk-row__who">{who}</span>
          )}
          {item.requisition_id !== null && item.requisition_label !== null ? (
            <Link to={`/requisitions/${item.requisition_id}`} className="rc-desk-row__req num">
              {item.requisition_label}
            </Link>
          ) : null}
          <span className={`rc-desk-kindbadge rc-desk-kind--${kind.tone}`}>{kind.label}</span>
        </span>
        {item.reason !== '' ? (
          <span className="rc-desk-row__why">{item.reason}</span>
        ) : null}
      </span>
      <span className="rc-desk-row__right">
        <span className={`rc-desk-due rc-desk-due--${item.urgency}`}>
          {urgencyLabel(item.urgency)}
        </span>
        {item.primary_action !== null ? (
          <DeskAction action={item.primary_action} />
        ) : null}
      </span>
    </div>
  );
}

function DeskAction({ action }: { action: NonNullable<DeskPriorityItemView['primary_action']> }) {
  if (action.href !== null) {
    return (
      <Link to={action.href} className="rc-link-action">
        {action.label}
      </Link>
    );
  }
  // Non-navigation action kinds arrive with backend Increment-2; until then a
  // desk item always carries a navigable href, so this branch renders a plain,
  // non-fabricated label rather than inventing a mutation.
  return <span className="rc-desk-action-pending">{action.label}</span>;
}

// --- presentational helpers (no business derivation) ---

function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

// Format the server-provided civil date "YYYY-MM-DD" WITHOUT a timezone shift:
// build a local Date from the parts (never `new Date(iso)`, which is UTC).
function formatDeskDate(serverDate: string): string {
  const [y, m, d] = serverDate.split('-').map((n) => Number(n));
  if (!y || !m || !d) return '';
  const dt = new Date(y, m - 1, d);
  return dt
    .toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    .toUpperCase();
}

function formatTime(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Urgency word — server-authoritative classification (§38); the FE never
// recomputes a day-diff against the browser clock.
function urgencyLabel(u: DeskUrgency): string {
  return u === 'overdue' ? 'Overdue' : u === 'today' ? 'Today' : 'Upcoming';
}

function interviewLabel(type: string): string {
  return type
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
