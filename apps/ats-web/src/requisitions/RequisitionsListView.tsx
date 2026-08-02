import {
  Button,
  InlineAlert,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { listCompanies } from '../companies/companies-api';
import { listAllPipelines } from '../pipeline/pipeline-api';
import {
  funnelByRequisition,
  rollupByRequisition,
  type ReqFunnel,
  type ReqPipelineCount,
} from '../pipeline/rollup';
import { resolveUserNames } from '../users/users-api';
import {
  Avatar,
  Card,
  FilterChip,
  Icons,
  ScopedSearch,
  StatusPill,
  Toolbar,
  type FunnelBucketKey,
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

// Requisitions LIST — rebuilt to Requisitions.dc.html's TABLE grammar
// (Requisition · Talent · Pipeline · Owner · Updated · Status) under the
// PR-REQ rulings. Every column is wired to a REAL contract source; the
// prototype's mock-only affordances were ruled out, not stubbed:
//
//   • ROLE DIFFERENTIATION is SERVER-SIDE. GET /v1/requisitions applies the
//     A3/D4b visibility predicate from the caller's scopes
//     (requisition.repository.ts:listForActor): a recruiter sees assigned +
//     client-visible reqs; a requisition:read:all holder sees the full tenant
//     set. No query param — the list breadth differs by the LOGGED-IN
//     PRINCIPAL. "All" means "all requisitions visible to YOU"; "My reqs"
//     narrows client-side to where you are the recruiter/owner.
//   • Talent stat block (R2) = total IN PIPELINE + Submitted + Interview, from
//     the funnel breakdown of ONE unfiltered /v1/pipelines call grouped by
//     requisition_id (no N+1). "Submitted"/"Interview" are FUNNEL_BUCKETS'
//     own names (funnelByRequisition → stage-map's funnelCounts).
//   • Pipeline distribution bar = the same 6-bucket funnel, segmented.
//   • Company_id resolves to a name; owner resolves via the directory probe.
//   • external_req_id is rendered opportunistically (R4) — the title block
//     reads correctly when it is absent (the common case for manual reqs).
//
// RULED OUT of this surface (not mocked, not stubbed):
//   • Match/Matches (R1) — the reserved seam lives on the DETAIL page only;
//     it never appears in a list row and is never a disabled number slot.
//   • Star/favorite (R6) — no per-user favorite field exists (Charter §4).
//   • Per-talent "source" / next-step / "New" count (R6/R7) — no contract
//     source; omitted, no placeholder column.
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
  const [funnels, setFunnels] = useState<Record<string, ReqFunnel>>({});
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  // Default to "My reqs" — the recruiter-centric lens. NOTE this is a
  // CLIENT-SIDE narrowing of the already-visibility-scoped payload, not a
  // server-side owned-query — see the isMine docstring below.
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
        // ONE call → two projections: the active/submitted counts the banner,
        // aging and sort read, and the 6-bucket funnel the stat block +
        // distribution bar render. No N+1.
        setPipelineCounts(rollupByRequisition(pipeRes.value.items));
        setFunnels(funnelByRequisition(pipeRes.value.items));
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
      // D1-a — the default closed-hide is a DEFAULT, not an override. It hides
      // terminal statuses (full/closed/canceled) from the unfiltered list, but
      // an explicit status selection below is authoritative: picking Closed /
      // Full / Canceled in the dropdown must surface those rows even while the
      // "Include closed" chip is off. So the default only applies when no explicit
      // status is chosen. (The chip↔dropdown model itself is D1-b.)
      if (!showClosed && statusFilter === '' && isClosedStatus(r.status)) {
        return false;
      }
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

  // R5 — the summary line uses ONLY real enum values (active / on hold /
  // closed). No derived "open" bucket, and no total implying these sum.
  const activeCount = items.filter((r) => r.status === 'active').length;
  const onHoldCount = items.filter((r) => r.status === 'on_hold').length;
  const closedCount = items.filter((r) => r.status === 'closed').length;
  const readyCount = filtered.length;
  const capped = items.length >= LIST_CAP;

  return (
    <section>
      <div className="rc-viewhead">
        <div>
          <h1 className="rc-h1">Requisitions</h1>
          <p className="rc-sub">
            {activeCount} active · {onHoldCount} on hold · {closedCount} closed
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
          <FilterChip
            active={mode === 'needs_sourcing'}
            onClick={() => setMode('needs_sourcing')}
          >
            Needs sourcing
          </FilterChip>
          <FilterChip active={mode === 'aging'} onClick={() => setMode('aging')}>
            Aging
          </FilterChip>
          {/* Intentional divergence from the mockup: "Include closed" stays an
              explicit chip (the mockup folds closed into the status dropdown —
              not worth the churn). */}
          <FilterChip
            active={showClosed}
            onClick={() => setShowClosed((s) => !s)}
          >
            Include closed
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
            <div className="rc-rt__scroll">
              <div className="rc-rt">
                <div className="rc-rt__head" role="row">
                  <span className="rc-rt__hc">Requisition</span>
                  <span className="rc-rt__hc">Talent</span>
                  <span className="rc-rt__hc">Pipeline</span>
                  <span className="rc-rt__hc">Owner</span>
                  <span className="rc-rt__hc">Updated</span>
                  <span className="rc-rt__hc">Status</span>
                </div>
                {filtered.map((r) => (
                  <RequisitionRow
                    key={r.id}
                    req={r}
                    companyName={companyNames[r.company_id]}
                    funnel={funnels[r.id]}
                    ownerName={ownerName(r, userNames)}
                  />
                ))}
              </div>
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
  readonly funnel: ReqFunnel | undefined;
  readonly ownerName: string | null;
}

function RequisitionRow({
  req,
  companyName,
  funnel,
  ownerName: owner,
}: RequisitionRowProps) {
  const detailHref = `/requisitions/${req.id}`;
  const total = funnel?.total ?? 0;
  const cellCount = (key: FunnelBucketKey): number =>
    funnel?.cells.find((c) => c.key === key)?.count ?? 0;
  const cellLabel = (key: FunnelBucketKey, fallback: string): string =>
    funnel?.cells.find((c) => c.key === key)?.label ?? fallback;

  // R4 — the identity sub-line renders whatever is present. external_req_id is
  // absent for manually-created reqs; the line then reads "Company · Location"
  // with no dangling separator.
  const idParts: ReactNode[] = [];
  if (req.external_req_id != null) {
    idParts.push(
      <span key="rid" className="mono">
        {req.external_req_id}
      </span>,
    );
  }
  if (companyName != null) idParts.push(<span key="co">{companyName}</span>);
  const loc = locationOf(req);
  if (loc !== '—') idParts.push(<span key="loc">{loc}</span>);

  return (
    <article
      id={rowDomId(req.id)}
      className={`rc-rt__row${req.is_hot ? ' rc-rt__row--hot' : ''}`}
      role="row"
    >
      {/* Requisition */}
      <div className="rc-rt__req">
        <div className="rc-rt__top">
          <Link to={detailHref} className="rc-rt__title">
            {req.title}
          </Link>
          {req.is_hot ? <span className="rc-rt__hot">Hot</span> : null}
        </div>
        {idParts.length > 0 ? (
          <div className="rc-rt__sub">
            {idParts.map((part, i) => (
              <span key={i} className="rc-rt__subpart">
                {i > 0 ? <span className="rc-rt__dot">·</span> : null}
                {part}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {/* Talent — R2 stat block: total in pipeline + Submitted + Interview */}
      <div className="rc-rt__stats">
        <span className="rc-stat rc-stat--lead">
          <b className="num">{total}</b>
          <span className="rc-stat__l">In pipeline</span>
        </span>
        <span className="rc-stat">
          <b className="num">{cellCount('submitted')}</b>
          <span className="rc-stat__l">{cellLabel('submitted', 'Submitted')}</span>
        </span>
        <span className="rc-stat">
          <b className="num">{cellCount('interview')}</b>
          <span className="rc-stat__l">{cellLabel('interview', 'Interview')}</span>
        </span>
      </div>

      {/* Pipeline — the 6-bucket funnel, segmented */}
      <div className="rc-rt__pipe">
        <span className="rc-distbar" aria-hidden="true">
          {total > 0
            ? (funnel?.cells ?? [])
                .filter((c) => c.count > 0)
                .map((c) => (
                  <i
                    key={c.key}
                    className={`rc-distseg rc-distseg--${c.key}`}
                    style={{ width: `${(c.count / total) * 100}%` }}
                  />
                ))
            : null}
        </span>
        <span className="rc-distbar__n mono">{total}</span>
      </div>

      {/* Owner */}
      <div className="rc-rt__owner" title={owner ?? 'Unassigned'}>
        {owner != null ? (
          <Avatar name={owner} size="sm" />
        ) : (
          <Avatar initials="?" size="sm" />
        )}
      </div>

      {/* Updated */}
      <div className="rc-rt__upd">{relativeTime(req.updated_at)}</div>

      {/* Status — the real 6-value enum (R5) */}
      <div className="rc-rt__status">
        <StatusPill tone={STATUS_TONE[req.status]} dot>
          {STATUS_LABEL[req.status]}
        </StatusPill>
      </div>
    </article>
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

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
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
