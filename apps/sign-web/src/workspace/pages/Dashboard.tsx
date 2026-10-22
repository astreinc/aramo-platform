import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { errorMessage, senderApi, type EnvelopeRow, type Summary } from '../api';
import { ErrorBox, Loading, StatusPill, rel } from '../ui';
import { useWorkspace } from '../workspace';

import { PersonalAllowance } from './PersonalAllowance';

function greeting(now: Date): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function monthLabel(ym: string): string {
  const m = Number(ym.slice(5, 7));
  return MONTHS[m - 1] ?? ym;
}

export function Dashboard() {
  const { ctx, base } = useWorkspace();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [recent, setRecent] = useState<EnvelopeRow[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    Promise.all([senderApi.summary(), senderApi.list()])
      .then(([s, l]) => {
        setSummary(s);
        setRecent(l.items.slice(0, 5));
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  const first = (ctx.user.display_name ?? '').split(' ')[0] ?? '';
  const personal = ctx.workspace === 'personal';

  return (
    <div className="sg-page sg-page--wide">
      <h1 className="sg-h1">
        {greeting(new Date())}
        {first !== '' ? `, ${first}` : ''}.
      </h1>
      <p className="sg-lede">{personal ? 'Here’s what’s happening with your documents.' : 'Here’s what’s happening with your agreements.'}</p>
      {personal && ctx.personal_sending_enabled !== true ? (
        <div className="sg-note" style={{ marginTop: 14 }} data-testid="personal-note">
          <span className="sg-tag sg-tag--grey">Personal</span>
          Sending from a personal account isn’t enabled yet. You can see envelopes you’re part of here.
        </div>
      ) : null}
      {/* Aramo Sign Personal (Free) §4 — 2 a day, 5 a month, from the backend's ledger. */}
      {personal && ctx.personal_sending_enabled === true ? <PersonalAllowance /> : null}
      {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
      {summary === null && error === '' ? <Loading /> : null}
      {summary !== null ? (
        <>
          <div className="sg-grid sg-grid--4" style={{ marginTop: 22 }}>
            <Stat label="Awaiting signatures" n={summary.awaiting_signatures} sub="envelopes in progress" color="var(--ink)" />
            <Stat label="Requires your action" n={summary.counts.draft} sub="drafts to finish" color="var(--accent)" />
            <Stat label="Completed this month" n={summary.completed_this_month} sub="fully executed" color="var(--ok)" />
            <Stat label="Declined or expired" n={summary.declined_or_expired} sub="need a follow-up" color="var(--bad)" />
          </div>
          <div className="sg-grid sg-grid--main" style={{ marginTop: 14 }}>
            <section className="sg-card">
              <div className="sg-card__head">
                Recent envelopes
                <Link className="sg-card__end" to={`${base}/envelopes`}>
                  View all
                </Link>
              </div>
              {recent !== null && recent.length === 0 ? (
                <div className="sg-empty">
                  <div className="sg-empty__t">No envelopes yet</div>
                  {ctx.can_send ? <Link to={`${base}/envelopes/new`}>Create your first envelope</Link> : null}
                </div>
              ) : null}
              {(recent ?? []).map((e) => (
                <Link key={e.id} className="sg-row" to={`${base}/envelopes/${e.id}${e.status === 'DRAFT' && ctx.can_send ? '/edit?step=1' : ''}`}>
                  <div className="sg-row__main">
                    <div className="sg-row__t sg-ellipsis">{e.subject}</div>
                    <div className="sg-row__s sg-ellipsis">
                      {e.recipients.map((r) => r.name).join(', ') || '(no recipients yet)'} · {rel(e.last_activity_at)}
                    </div>
                  </div>
                  <StatusPill status={e.status} />
                </Link>
              ))}
            </section>
            <div className="sg-grid">
              <section className="sg-card">
                <div className="sg-card__head">Quick actions</div>
                <div className="sg-card__body sg-grid sg-grid--2">
                  {ctx.can_send ? (
                    <Link className="sg-btn" style={{ justifyContent: 'flex-start' }} to={`${base}/envelopes/new`}>
                      Upload document
                    </Link>
                  ) : (
                    <span className="sg-btn" aria-disabled="true" style={{ justifyContent: 'flex-start', opacity: 0.5 }}>
                      Upload document
                    </span>
                  )}
                  {personal ? null : (
                    <Link className="sg-btn" style={{ justifyContent: 'flex-start' }} to={`${base}/templates`}>
                      Use template
                    </Link>
                  )}
                  <Link className="sg-btn" style={{ justifyContent: 'flex-start' }} to={`${base}/envelopes?tab=waiting`}>
                    Awaiting signatures
                  </Link>
                  <Link className="sg-btn" style={{ justifyContent: 'flex-start' }} to={`${base}/activity`}>
                    Recent activity
                  </Link>
                </div>
              </section>
              <section className="sg-card" data-testid="completion-chart">
                <div className="sg-card__head">
                  Completion · last 6 months
                  <span className="sg-card__end sg-muted">{summary.completion_rate === null ? 'No envelopes sent yet' : `${summary.completion_rate}% completed`}</span>
                </div>
                <div className="sg-card__body">
                  <Bars months={summary.months} height={70} />
                </div>
              </section>
              <section className="sg-card">
                <div className="sg-card__head">Expiring soon</div>
                <div className="sg-card__body">
                  {summary.expiring_soon.length === 0 ? <div className="sg-muted">Nothing expires in the next 3 days.</div> : null}
                  {summary.expiring_soon.map((x) => {
                    const days = Math.max(0, Math.ceil((new Date(x.expires_at).getTime() - Date.now()) / 86_400_000));
                    return (
                      <div key={x.id} className="sg-settings-row">
                        <Link to={`${base}/envelopes/${x.id}`} style={{ color: 'var(--ink)' }} className="sg-ellipsis">
                          {x.subject}
                        </Link>
                        <span style={{ marginLeft: 'auto', color: 'var(--warn)', fontWeight: 600, whiteSpace: 'nowrap' }}>{days === 0 ? 'today' : `${days}d left`}</span>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, n, sub, color }: { label: string; n: number; sub: string; color: string }) {
  return (
    <div className="sg-card sg-stat">
      <div className="sg-stat__l">{label}</div>
      <div className="sg-stat__n" style={{ color }}>
        {n}
      </div>
      <div className="sg-stat__s">{sub}</div>
    </div>
  );
}

// Stacked monthly bars from REAL data: completed · in progress / other · declined or expired.
export function Bars({ months, height = 150 }: { months: Summary['months']; height?: number }) {
  const max = Math.max(1, ...months.map((m) => m.sent));
  return (
    <div>
      <div className="sg-bars" style={{ height }}>
        {months.map((m) => {
          const other = Math.max(0, m.sent - m.completed - m.declined_or_expired);
          const h = (v: number) => `${(v / max) * 100}%`;
          return (
            <div key={m.month} className="sg-bars__col" title={`${monthLabel(m.month)}: ${m.sent} sent, ${m.completed} completed`}>
              <div style={{ height: h(m.completed), background: 'var(--accent)', borderRadius: '3px 3px 0 0' }} />
              <div style={{ height: h(other), background: '#A9B8F1' }} />
              <div style={{ height: h(m.declined_or_expired), background: '#F6D9D6' }} />
              {m.sent === 0 ? <div style={{ height: 2, background: 'var(--line)' }} /> : null}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {months.map((m) => (
          <div key={m.month} className="sg-bars__lab" style={{ flex: 1 }}>
            {monthLabel(m.month)}
          </div>
        ))}
      </div>
    </div>
  );
}
