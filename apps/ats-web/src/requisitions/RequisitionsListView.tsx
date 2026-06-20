import {
  Button,
  InlineAlert,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { listCompanies } from '../companies/companies-api';
import { listAllPipelines } from '../pipeline/pipeline-api';
import { rollupByRequisition, type ReqPipelineCount } from '../pipeline/rollup';
import { resolveUserNames } from '../users/users-api';
import {
  Avatar,
  Card,
  FilterChip,
  Icons,
  ScopedSearch,
  StatusPill,
  Toolbar,
  type PillTone,
} from '../ui';

import { listRequisitions } from './requisitions-api';
import { listErrorMessage } from './error-messages';
import {
  isClosedStatus,
  REQUISITION_STATUS_VALUES,
  type RequisitionStatus,
  type RequisitionView,
} from './types';

// Requisitions LIST — rebuilt to the enterprise mockup's card-row grammar
// (the "needs-attention" banner, a richer filter bar, stacked requisition rows
// with a meta strip + owner cell + a reserved AI-matching seam) while staying
// 100% backed by real data:
//
//   • ROLE DIFFERENTIATION is SERVER-SIDE and automatic. GET /v1/requisitions
//     applies the A3/D4b visibility predicate from the caller's scopes
//     (requisition.repository.ts:listForActor) — a recruiter sees assigned +
//     client-visible reqs; a requisition:read:all holder (e.g. an admin/lead
//     with see-all) sees the full tenant set. The list breadth differs by the
//     LOGGED-IN PRINCIPAL with NO query param — the mockup's persona switcher
//     mocked exactly what the JWT already does for real, so it is dropped.
//     "All" here means "all requisitions visible to YOU" (hence the "visible"
//     count in the sub-line), and "Only mine" narrows client-side to where you
//     are the recruiter/owner.
//   • Pipeline / Submitted counts come from ONE unfiltered /v1/pipelines call
//     grouped by requisition_id (no N+1); openings + owner are real fields;
//     company_id resolves to a name; the recruiter name resolves via the
//     admin-gated roster probe (graceful 403 → unresolved).
//
// RESERVED (not mocked): the per-row "AI matching" pill is a DISABLED seam — no
// match engine exists pre-Core, so there is no panel, no simulation, and no
// ordinal-verdict surface (tiers/verdicts are a Core output, R10).
//
// DEFERRED (unbacked — see go-live-known-limitations.md): a server-side
// owner-IS-NULL "Unassigned" filter, "Team" scope, and owner reassignment.
// The owner cell still DISPLAYS the real unassigned state; it offers no action.

const STATUS_LABEL: Record<RequisitionStatus, string> = {
  active: 'Active',
  on_hold: 'On hold',
  full: 'Full',
  closed: 'Closed',
  canceled: 'Canceled',
  lead: 'Intake',
};

const STATUS_TONE: Record<RequisitionStatus, PillTone> = {
  active: 'ok',
  lead: 'neutral',
  on_hold: 'warn',
  full: 'brand',
  closed: 'neutral',
  canceled: 'danger',
};

type FilterMode = 'mine' | 'all' | 'hot' | 'needs_sourcing' | 'aging';
type SortKey = 'focus' | 'aging' | 'pipeline' | 'new';

// A requisition is "aging" (needs-attention) when it has been open a while
// with nothing submitted yet — both signals are real/derived, never fabricated.
const AGING_DAYS = 21;
// The BE caps the visibility-scoped list at 50 (no cursor yet). When the result
// hits the cap we say so rather than imply completeness.
const LIST_CAP = 50;

interface RequisitionsListViewProps {
  readonly sessionOverride?: Session;
}

export function RequisitionsListView({
  sessionOverride,
}: RequisitionsListViewProps = {}) {
  const [items, setItems] = useState<readonly RequisitionView[]>([]);
  const [companyNames, setCompanyNames] = useState<Record<string, string>>({});
  const [pipelineCounts, setPipelineCounts] = useState<
    Record<string, ReqPipelineCount>
  >({});
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  // Default to "My reqs" — the recruiter-centric lens (mockup parity). NOTE
  // this is a CLIENT-SIDE narrowing of the already-visibility-scoped payload,
  // not a server-side owned-query — see the isMine docstring below.
  const [mode, setMode] = useState<FilterMode>('mine');
  const [client, setClient] = useState('');
  const [statusFilter, setStatusFilter] = useState<RequisitionStatus | ''>('');
  const [sort, setSort] = useState<SortKey>('focus');
  const [query, setQuery] = useState('');

  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canCreate =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'requisition:create');
  const myId = session?.sub ?? null;
  // A requisition:read:all holder (admin/lead) receives the FULL tenant set
  // server-side; everyone else already receives only their assigned reqs.
  const hasReadAll =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'requisition:read:all');

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      listRequisitions(),
      listCompanies(),
      listAllPipelines(),
      resolveUserNames(),
    ]).then(([reqRes, coRes, pipeRes, namesRes]) => {
      if (cancelled) return;
      if (reqRes.status === 'fulfilled') {
        setItems(reqRes.value.items);
      } else {
        setError(listErrorMessage(reqRes.reason));
      }
      if (coRes.status === 'fulfilled') {
        const map: Record<string, string> = {};
        for (const c of coRes.value.items) map[c.id] = c.name;
        setCompanyNames(map);
      }
      if (pipeRes.status === 'fulfilled') {
        setPipelineCounts(rollupByRequisition(pipeRes.value.items));
      }
      // §5 D4c — recruiter/owner names from the directory (incl. departed).
      if (namesRes.status === 'fulfilled') {
        setUserNames(namesRes.value);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // "My reqs" — CLIENT-SIDE, persona-aware. GET /v1/requisitions has NO
  // owner/mine param (only site_id/company_id/q); breadth is server-enforced
  // by scope (requisition.repository.listForActor): a read:all holder gets the
  // full tenant set, everyone else ALREADY gets only assignments.user_id==sub.
  // So:
  //   - non-read:all (plain recruiter): the whole payload is already theirs →
  //     "My reqs" == "All" (return true). Filtering by the owner/recruiter
  //     FIELD here would WRONGLY hide reqs they're assigned-to-but-not-owner-of
  //     (and could blank the default view), so we don't.
  //   - read:all holder (admin/lead): the payload is tenant-wide → narrow to
  //     where they are the recruiter/owner field.
  // This is NOT a leak (the payload is already visibility-scoped) but it is
  // also NOT a true server-side owned/assigned query — a ?scope=mine BE param
  // is a CARRY (would let "My reqs" mean owned-OR-assigned precisely, and
  // enable correct pagination). Reported as the My-reqs scoping finding.
  const isMine = (r: RequisitionView): boolean => {
    if (!hasReadAll) return true;
    return (
      (r.recruiter_id !== null && r.recruiter_id === myId) ||
      (r.owner_id !== null && r.owner_id === myId)
    );
  };

  // "Aging" and "Needs sourcing" are derived from the already-loaded set —
  // no new call, no fabricated signal. Aging = open a while with nothing
  // submitted; Needs sourcing = active req with an empty pipeline.
  const isAging = (r: RequisitionView): boolean =>
    !isClosedStatus(r.status) &&
    daysOpen(r) >= AGING_DAYS &&
    (pipelineCounts[r.id]?.submitted ?? 0) === 0;
  const needsSourcing = (r: RequisitionView): boolean =>
    !isClosedStatus(r.status) && (pipelineCounts[r.id]?.active ?? 0) === 0;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = items.filter((r) => {
      if (!showClosed && isClosedStatus(r.status)) return false;
      if (mode === 'hot' && !r.is_hot) return false;
      if (mode === 'mine' && !isMine(r)) return false;
      if (mode === 'aging' && !isAging(r)) return false;
      if (mode === 'needs_sourcing' && !needsSourcing(r)) return false;
      if (client !== '' && r.company_id !== client) return false;
      if (statusFilter !== '' && r.status !== statusFilter) return false;
      if (q !== '') {
        const hay = `${r.title} ${companyNames[r.company_id] ?? ''} ${
          r.external_req_id ?? ''
        }`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    return sortRows(rows, sort, pipelineCounts);
  }, [
    items,
    showClosed,
    mode,
    client,
    statusFilter,
    query,
    sort,
    myId,
    companyNames,
    pipelineCounts,
  ]);

  // Needs-attention: hot, or aging (open >= AGING_DAYS with nothing submitted).
  // Derived from the already-loaded set within the current scope — no new call,
  // no fabricated signal.
  const focusItems = useMemo(
    () =>
      filtered
        .filter((r) => {
          if (isClosedStatus(r.status)) return false;
          if (r.is_hot) return true;
          const submitted = pipelineCounts[r.id]?.submitted ?? 0;
          return daysOpen(r) >= AGING_DAYS && submitted === 0;
        })
        .slice(0, 6),
    [filtered, pipelineCounts],
  );

  const openCount = items.filter((r) => !isClosedStatus(r.status)).length;
  const readyCount = filtered.length;
  const capped = items.length >= LIST_CAP;

  return (
    <section>
      <div className="rc-viewhead">
        <div>
          <h1 className="rc-h1">Requisitions</h1>
          <p className="rc-sub">
            {openCount} open · {items.length} visible to you
          </p>
        </div>
        {canCreate ? (
          <div className="rc-viewhead__actions">
            <Link to="/requisitions/new">
              <Button variant="primary">New requisition</Button>
            </Link>
          </div>
        ) : null}
      </div>

      {error !== null ? (
        <InlineAlert variant="error">{error}</InlineAlert>
      ) : null}

      {focusItems.length > 0 ? (
        <div className="rc-focus">
          <div className="rc-focus__ic">
            <Icons.IconBolt />
          </div>
          <div className="rc-focus__body">
            <h2 className="rc-focus__h">
              {focusItems.length} requisition
              {focusItems.length === 1 ? '' : 's'}{' '}
              {focusItems.length === 1 ? 'needs' : 'need'} attention
            </h2>
            <div className="rc-focus__row">
              {focusItems.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="rc-focus__k"
                  onClick={() => scrollToRow(r.id)}
                >
                  <span
                    className="rc-focus__d"
                    style={{ background: r.is_hot ? 'var(--hot)' : 'var(--warn)' }}
                  />
                  <span className="rc-focus__t">{r.title} —</span>{' '}
                  {focusReason(r, pipelineCounts)}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <Card flush className="rc-mt-16">
        <Toolbar>
          <FilterChip active={mode === 'mine'} onClick={() => setMode('mine')}>
            My reqs
          </FilterChip>
          <FilterChip active={mode === 'all'} onClick={() => setMode('all')}>
            All
          </FilterChip>
          <FilterChip active={mode === 'hot'} onClick={() => setMode('hot')}>
            Hot
          </FilterChip>
          {/* RESERVED SEAM — no Core match engine exists pre-Core, so this
              filter is DISABLED. No count is fabricated (R10): tiers/verdicts
              are a Core output. Enables when /v1/jobs/:id/matches is live. */}
          <FilterChip disabled title="Matching arrives with Aramo Core">
            Matches — coming with Aramo Core
          </FilterChip>
          <FilterChip
            active={mode === 'needs_sourcing'}
            onClick={() => setMode('needs_sourcing')}
          >
            Needs sourcing
          </FilterChip>
          <FilterChip active={mode === 'aging'} onClick={() => setMode('aging')}>
            Aging
          </FilterChip>
          {/* Intentional divergence from the mockup: "Show closed" stays an
              explicit chip (the mockup folds closed into the status dropdown —
              not worth the churn). */}
          <FilterChip
            active={showClosed}
            onClick={() => setShowClosed((s) => !s)}
          >
            Show closed
          </FilterChip>
          <span className="rc-toolbar__sep" />
          <select
            className="rc-fsel"
            aria-label="Filter by client"
            value={client}
            onChange={(e) => setClient(e.target.value)}
          >
            <option value="">All clients</option>
            {clientOptions(items, companyNames).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            className="rc-fsel"
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as RequisitionStatus | '')
            }
          >
            <option value="">Any status</option>
            {REQUISITION_STATUS_VALUES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <span className="rc-toolbar__grow" />
          <select
            className="rc-fsel"
            aria-label="Sort requisitions"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="focus">Sort: Focus</option>
            <option value="aging">Sort: Aging</option>
            <option value="pipeline">Sort: Pipeline</option>
            <option value="new">Sort: Newest</option>
          </select>
          <ScopedSearch
            placeholder="Search requisitions"
            value={query}
            onChange={setQuery}
          />
        </Toolbar>

        {loading ? (
          <p className="rc-empty">Loading requisitions…</p>
        ) : filtered.length === 0 ? (
          <p className="rc-empty">
            {items.length === 0
              ? 'No requisitions visible to you yet.'
              : 'No requisitions match these filters.'}
          </p>
        ) : (
          <>
            <div className="rc-listmeta">
              {readyCount} req{readyCount === 1 ? '' : 's'}
              {capped ? (
                <span>
                  · showing your {LIST_CAP} most recent (pagination coming)
                </span>
              ) : null}
            </div>
            <div className="rc-reqs">
              {filtered.map((r) => (
                <RequisitionRow
                  key={r.id}
                  req={r}
                  companyName={companyNames[r.company_id]}
                  counts={pipelineCounts[r.id]}
                  ownerName={ownerName(r, userNames)}
                />
              ))}
            </div>
          </>
        )}
      </Card>
    </section>
  );
}

interface RequisitionRowProps {
  readonly req: RequisitionView;
  readonly companyName: string | undefined;
  readonly counts: ReqPipelineCount | undefined;
  readonly ownerName: string | null;
}

function RequisitionRow({
  req,
  companyName,
  counts,
  ownerName: owner,
}: RequisitionRowProps) {
  const active = counts?.active ?? 0;
  const submitted = counts?.submitted ?? 0;
  const filled = req.openings - req.openings_available;
  const detailHref = `/requisitions/${req.id}`;

  return (
    <article
      id={rowDomId(req.id)}
      className={`rc-reqrow${req.is_hot ? ' rc-reqrow--focused' : ''}`}
    >
      <div className="rc-reqrow__main">
        <div className="rc-reqrow__l">
          <div className="rc-reqrow__top">
            <Link to={detailHref} className="rc-reqrow__title">
              {req.title}
              {req.is_hot ? <Icons.IconFlame aria-label="Hot" /> : null}
            </Link>
            {companyName != null ? (
              <span className="rc-reqrow__client">{companyName}</span>
            ) : null}
            {req.external_req_id != null ? (
              <span className="rc-reqrow__rid mono">{req.external_req_id}</span>
            ) : null}
            {req.is_hot ? (
              <StatusPill tone="hot">Hot</StatusPill>
            ) : (
              <StatusPill tone={STATUS_TONE[req.status]} dot>
                {STATUS_LABEL[req.status]}
              </StatusPill>
            )}
          </div>
          <div className="rc-reqrow__meta">
            <span className="rc-rm">
              <Icons.IconBriefcase />
              {req.type ?? '—'}
            </span>
            <span className="rc-rm">
              <Icons.IconPin />
              {locationOf(req)}
            </span>
            <span className="rc-rm">
              <PipeBar active={active} submitted={submitted} />
              <b className="num">{active}</b> in pipeline
            </span>
            <span className="rc-rm">
              <b className="num">{submitted}</b> submitted
            </span>
            <span className="rc-rm">
              <b className="num">
                {filled}/{req.openings}
              </b>{' '}
              filled
            </span>
            <span className="rc-rm">
              <Icons.IconClock />
              {daysOpen(req)}d open
            </span>
          </div>
        </div>

        <div className="rc-reqrow__r">
          <div className="rc-owner">
            {owner != null ? (
              <>
                <Avatar name={owner} size="sm" />
                <span className="rc-owner__nm">{owner}</span>
              </>
            ) : (
              <>
                <Avatar initials="?" size="sm" />
                <span className="rc-owner__nm">Unassigned</span>
              </>
            )}
          </div>
          {/* Reserved seam — AI matching activates with Aramo Core. No engine
              exists yet, so the control is disabled (no panel, no verdicts). */}
          <button
            type="button"
            className="rc-apill"
            disabled
            title="AI matching arrives with Aramo Core"
          >
            <Icons.IconBolt />
            AI matching — coming with Aramo Core
          </button>
          <Link
            to={detailHref}
            className="rc-reqrow__chev"
            aria-label={`Open ${req.title}`}
          >
            <Icons.IconChevronRight />
          </Link>
        </div>
      </div>
    </article>
  );
}

function PipeBar({ active, submitted }: { active: number; submitted: number }) {
  const total = Math.max(active, 1);
  const subPct = Math.min(100, (submitted / total) * 100);
  const activePct = Math.max(0, 100 - subPct);
  return (
    <span className="rc-pipebar" aria-hidden="true">
      <i className="is-sub" style={{ width: `${subPct}%` }} />
      <i className="is-active" style={{ width: `${activePct}%` }} />
    </span>
  );
}

// ─────────────── helpers ───────────────

function rowDomId(id: string): string {
  return `req-row-${id}`;
}

function scrollToRow(id: string): void {
  const el = document.getElementById(rowDomId(id));
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function daysOpen(r: RequisitionView): number {
  const created = Date.parse(r.created_at);
  if (Number.isNaN(created)) return 0;
  return Math.max(0, Math.floor((Date.now() - created) / 86_400_000));
}

function focusReason(
  r: RequisitionView,
  counts: Record<string, ReqPipelineCount>,
): string {
  const age = daysOpen(r);
  if (r.is_hot) return `hot · ${age}d open`;
  const submitted = counts[r.id]?.submitted ?? 0;
  return `aging · ${age}d open, ${submitted} submitted`;
}

function ownerName(
  r: RequisitionView,
  names: Record<string, string>,
): string | null {
  const id = r.recruiter_id ?? r.owner_id;
  if (id === null) return null;
  return names[id] ?? null;
}

function locationOf(r: RequisitionView): string {
  const place = [r.city, r.state].filter(Boolean).join(', ');
  const remote =
    r.work_arrangement === 'remote'
      ? 'Remote'
      : r.work_arrangement === 'hybrid'
        ? 'Hybrid'
        : null;
  if (place && remote) return `${place} · ${remote}`;
  return place || remote || '—';
}

function clientOptions(
  items: readonly RequisitionView[],
  names: Record<string, string>,
): ReadonlyArray<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const r of items) {
    const name = names[r.company_id];
    if (name != null && !seen.has(r.company_id)) seen.set(r.company_id, name);
  }
  return [...seen.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function sortRows(
  rows: readonly RequisitionView[],
  sort: SortKey,
  counts: Record<string, ReqPipelineCount>,
): RequisitionView[] {
  const out = [...rows];
  out.sort((a, b) => {
    switch (sort) {
      case 'focus': {
        // Hot first, then the oldest-open (the needs-attention lens).
        if (a.is_hot !== b.is_hot) return a.is_hot ? -1 : 1;
        return daysOpen(b) - daysOpen(a);
      }
      case 'aging':
        return daysOpen(b) - daysOpen(a);
      case 'pipeline':
        return (counts[b.id]?.active ?? 0) - (counts[a.id]?.active ?? 0);
      case 'new':
      default:
        return Date.parse(b.created_at) - Date.parse(a.created_at);
    }
  });
  return out;
}
