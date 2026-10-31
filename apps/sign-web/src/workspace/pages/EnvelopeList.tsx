import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Dialog } from '@aramo/fe-foundation';

import { errorMessage, senderApi, sourceLabel, type EnvelopeList as EnvelopeListData, type EnvelopeRow, type EnvelopeStatus } from '../api';
import { Btn, Check, ErrorBox, LinkBtn, Loading, PurgeTag, Sel, StatusPill, TextIn, fmtDate, rel } from '../ui';
import { useWorkspace } from '../workspace';

// Retention and Purge (DocuSign parity) — Delete moves a completed, declined, voided or
// expired envelope to this organization's Deleted folder only (other parties keep theirs);
// Restore brings it back until a purge has run. The backend decides; these mirror it.
const DELETABLE: ReadonlySet<EnvelopeStatus> = new Set(['COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED']);

// Envelopes — tabs All / Drafts / Waiting for others / Completed / Declined /
// Voided / Expired (prototype), with a subject/recipient filter, a date range and
// a sort. Draft rows open the wizard; everything else opens the read-only detail.

const TABS: { key: string; label: string; statuses: EnvelopeStatus[] | null }[] = [
  { key: 'all', label: 'All', statuses: null },
  { key: 'drafts', label: 'Drafts', statuses: ['DRAFT'] },
  { key: 'waiting', label: 'Waiting for others', statuses: ['SENT', 'IN_PROGRESS'] },
  { key: 'completed', label: 'Completed', statuses: ['COMPLETED'] },
  { key: 'declined', label: 'Declined', statuses: ['DECLINED'] },
  { key: 'voided', label: 'Voided', statuses: ['VOIDED'] },
  { key: 'expired', label: 'Expired', statuses: ['EXPIRED'] },
];

export function EnvelopeList({ folder }: { folder?: 'deleted' } = {}) {
  const { ctx, base, toast, refreshCounts } = useWorkspace();
  const deleted = folder === 'deleted';
  const [params, setParams] = useSearchParams();
  const tab = !deleted && TABS.some((t) => t.key === params.get('tab')) ? (params.get('tab') as string) : 'all';
  const [pending, setPending] = useState<{ row: EnvelopeRow; action: 'delete' | 'restore' } | null>(null);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [q, setQ] = useState(params.get('q') ?? '');
  const [days, setDays] = useState<number | undefined>(undefined);
  const [sort, setSort] = useState<'recent' | 'subject' | 'status'>('recent');
  const [data, setData] = useState<EnvelopeListData | null>(null);
  const [error, setError] = useState('');
  const [sel, setSel] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setQ(params.get('q') ?? '');
  }, [params]);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      senderApi
        .list({ tab, q, ...(days !== undefined ? { days } : {}), ...(deleted ? { folder: 'deleted' as const } : {}) })
        .then((d) => {
          if (live) {
            setData(d);
            setError('');
          }
        })
        .catch((e: unknown) => {
          if (live) setError(errorMessage(e));
        });
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [tab, q, days, deleted, reload]);

  const act = useCallback(async () => {
    if (pending === null) return;
    setBusy(true);
    setActionError('');
    try {
      if (pending.action === 'delete') await senderApi.deleteEnvelope(pending.row.id);
      else await senderApi.restoreEnvelope(pending.row.id);
      toast(pending.action === 'delete' ? 'Moved to Deleted' : 'Envelope restored');
      setPending(null);
      setReload((n) => n + 1);
      refreshCounts();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [pending, toast, refreshCounts]);

  const rows = useMemo(() => {
    const items = [...(data?.items ?? [])];
    if (sort === 'subject') items.sort((a, b) => a.subject.localeCompare(b.subject));
    if (sort === 'status') items.sort((a, b) => a.status.localeCompare(b.status));
    return items;
  }, [data, sort]);

  const count = (statuses: EnvelopeStatus[] | null): number => {
    const c = data?.counts ?? {};
    if (statuses === null) return Object.values(c).reduce((a, b) => a + (b ?? 0), 0);
    return statuses.reduce((a, s) => a + (c[s] ?? 0), 0);
  };
  const selected = Object.values(sel).filter(Boolean).length;

  return (
    <div className="sg-page sg-page--wide">
      <div className="sg-pagehead">
        <h1 className="sg-h1">{deleted ? 'Deleted' : 'Envelopes'}</h1>
        {ctx.can_send && !deleted ? (
          <div className="sg-pagehead__end">
            <Link className="sg-btn sg-btn--primary" to={`${base}/envelopes/new`}>
              + New envelope
            </Link>
          </div>
        ) : null}
      </div>
      {deleted ? (
        <p className="sg-muted" style={{ marginTop: 0 }} data-testid="deleted-help">
          Envelopes you deleted are hidden only for your organization. Recipients keep their copies. Restore an envelope to move it back.
        </p>
      ) : null}
      <nav className="sg-tabs" aria-label="Envelope status" hidden={deleted}>
        {TABS.map((t) => (
          <Link
            key={t.key}
            className={t.key === tab ? 'sg-tab sg-tab--on' : 'sg-tab'}
            aria-current={t.key === tab ? 'page' : undefined}
            to={`${base}/envelopes${t.key === 'all' ? '' : `?tab=${t.key}`}`}
            onClick={() => setSel({})}
          >
            {t.label}
            <span className="sg-tab__n">{data === null ? '' : count(t.statuses)}</span>
          </Link>
        ))}
      </nav>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <TextIn
          aria-label="Filter by subject or recipient"
          placeholder="Filter by subject or recipient"
          style={{ maxWidth: 260 }}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            const next = new URLSearchParams(params);
            if (e.target.value === '') next.delete('q');
            else next.set('q', e.target.value);
            setParams(next, { replace: true });
          }}
        />
        <Sel aria-label="Date range" style={{ maxWidth: 140 }} value={days === undefined ? 'all' : String(days)} onChange={(e) => setDays(e.target.value === 'all' ? undefined : Number(e.target.value))}>
          <option value="all">Any date</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </Sel>
        <Sel aria-label="Sort" style={{ maxWidth: 160 }} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="recent">Most recent</option>
          <option value="subject">Subject A–Z</option>
          <option value="status">Status</option>
        </Sel>
        {selected > 0 ? <span className="sg-muted" style={{ alignSelf: 'center' }}>{selected} selected</span> : null}
      </div>
      {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
      {data === null && error === '' ? <Loading /> : null}
      {data !== null ? (
        <section className="sg-card">
          <div className="sg-tablewrap">
            <table className="sg-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }} aria-label="Select" />
                  <th>Subject</th>
                  <th>Recipients</th>
                  <th>Status</th>
                  <th>Last activity</th>
                  <th>Sent</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="sg-empty">
                        <div className="sg-empty__t">{deleted ? 'Nothing in Deleted' : 'No envelopes here'}</div>
                        {q !== '' ? 'Try a different filter.' : null}
                      </div>
                    </td>
                  </tr>
                ) : null}
                {rows.map((e) => (
                  <tr key={e.id} data-testid={`envelope-row-${e.id}`}>
                    <td>
                      <Check aria-label={`Select ${e.subject}`} checked={sel[e.id] === true} onChange={(ev) => setSel((s) => ({ ...s, [e.id]: ev.target.checked }))} />
                    </td>
                    <td>
                      <Link
                        to={`${base}/envelopes/${e.id}${e.status === 'DRAFT' && ctx.can_send && sourceLabel(e.source_application) === null ? '/edit?step=1' : ''}`}
                        style={{ color: 'var(--ink)', fontWeight: 600 }}
                      >
                        {e.subject}
                      </Link>
                      {sourceLabel(e.source_application) !== null ? (
                        <span className="sg-tag sg-tag--blue" style={{ marginLeft: 8 }}>
                          {sourceLabel(e.source_application)}
                        </span>
                      ) : null}
                      <div className="sg-mono sg-faint" style={{ fontSize: 11.5 }}>
                        {e.id.slice(0, 8)}
                      </div>
                    </td>
                    <td className="sg-muted">{e.recipients.map((r) => r.name).join(', ') || '—'}</td>
                    <td>
                      <StatusPill status={e.status} /> <PurgeTag purge={e.purge} />
                    </td>
                    <td className="sg-muted">{rel(e.last_activity_at)}</td>
                    <td className="sg-muted">{e.sent_at === null ? '—' : fmtDate(e.sent_at)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {deleted && e.purge?.state !== 'EXECUTED' ? (
                        <LinkBtn onClick={() => setPending({ row: e, action: 'restore' })} data-testid={`restore-${e.id}`}>
                          Restore
                        </LinkBtn>
                      ) : null}
                      {!deleted && DELETABLE.has(e.status) ? (
                        <LinkBtn bad onClick={() => setPending({ row: e, action: 'delete' })} data-testid={`delete-${e.id}`}>
                          Delete
                        </LinkBtn>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sg-table__foot">
            <span>
              {rows.length} of {count(TABS.find((t) => t.key === tab)?.statuses ?? null)} envelopes
            </span>
            <span>Page 1 of 1</span>
          </div>
        </section>
      ) : null}
      <Dialog
        open={pending !== null}
        onOpenChange={(o) => {
          if (!o) {
            setPending(null);
            setActionError('');
          }
        }}
        title={pending?.action === 'restore' ? 'Restore this envelope?' : 'Delete this envelope?'}
        description={
          pending?.action === 'restore'
            ? 'It moves back to your envelopes.'
            : 'It moves to Deleted and is hidden for your organization only. Recipients keep their copies. You can restore it until it is purged.'
        }
        size="sm"
        footer={
          <>
            <Btn onClick={() => setPending(null)}>Cancel</Btn>
            <Btn variant={pending?.action === 'restore' ? 'primary' : 'danger'} disabled={busy} onClick={() => void act()} data-testid="confirm-envelope-action">
              {pending?.action === 'restore' ? 'Restore' : 'Delete'}
            </Btn>
          </>
        }
      >
        {pending !== null ? <strong>{pending.row.subject}</strong> : null}
        {actionError !== '' ? <ErrorBox>{actionError}</ErrorBox> : null}
      </Dialog>
    </div>
  );
}
