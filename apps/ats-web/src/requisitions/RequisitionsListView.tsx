import {
  Button,
  Combobox,
  InlineAlert,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { listCompanies } from '../companies/companies-api';
import { getTalentRecord, listAllPipelines } from '../pipeline/pipeline-api';
import {
  collapseToCurrentEpisode,
  funnelByRequisition,
  rollupByRequisition,
  type ReqFunnel,
  type ReqPipelineCount,
} from '../pipeline/rollup';
import {
  PIPELINE_NEXT_ACTION,
  PIPELINE_STATUS_LABELS,
  type PipelineView,
} from '../pipeline/types';
import { resolveUserNames } from '../users/users-api';
import {
  Avatar,
  Card,
  FilterChip,
  Icons,
  ScopedSearch,
  StatusPill,
  Toolbar,
  funnelBucket,
  type FunnelBucketKey,
} from '../ui';

import { TalentDetailPanel } from './TalentDetailPanel';
import { listRequisitions, setRequisitionBookmark } from './requisitions-api';
import { RECRUITING_STATUS_TONE as STATUS_TONE } from './status-tone';
import { listErrorMessage } from './error-messages';
import {
  isClosedStatus,
  RECRUITING_STATUS_LABELS,
  SELECTABLE_RECRUITING_STATUS_VALUES,
  type RecruitingStatus,
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
//   • Per-talent "source" / next-step / "New" count (R6/R7) — no contract
//     source; omitted, no placeholder column.
//
// PR-14 (Track C) UPDATE: a per-user personal bookmark field now DOES exist
// (user_requisition_state.bookmarked_at, enriched onto RequisitionView.bookmarked
// per calling user). The bookmark star below is PERSONAL — it never toggles
// is_hot (the team-wide HOT pill) and is invisible to other users. This
// supersedes the earlier "no per-user favorite field" note for R6.
//
// DEFERRED (unbacked — see go-live-known-limitations.md): a server-side
// owner-IS-NULL "Unassigned" filter, "Team" scope, and owner reassignment.
// The owner cell still DISPLAYS the real unassigned state; it offers no action.


// REQ-PIXEL-PARITY-1 cleanup — the wired chips reduce to Priority (hot) +
// Bookmarked; owner/status/location/company move to the prototype dropdowns.
// 'none' = no secondary chip active (recruiter-assignment scoping is
// backend-driven; the default list is the server-scoped payload).
type FilterMode = 'none' | 'hot' | 'bookmarked';
type SortKey = 'focus' | 'aging' | 'pipeline' | 'new';

// A requisition is "aging" (needs-attention) when it has been open a while
// with nothing submitted yet — both signals are real/derived, never fabricated.
const AGING_DAYS = 21;
// The BE caps the visibility-scoped list at 50 (no cursor yet). When the result
// hits the cap we say so rather than imply completeness.
const LIST_CAP = 50;

// P2-A — a pipeline entry shows the NEW badge if created within this many days.
const NEW_PIPELINE_DAYS = 7;
// Stable empty ref so a req with no pipeline doesn't churn the row each render.
const EMPTY_ENTRIES: readonly PipelineView[] = [];

function isNewEntry(e: PipelineView): boolean {
  const t = Date.parse(e.created_at);
  return !Number.isNaN(t) && Date.now() - t < NEW_PIPELINE_DAYS * 86_400_000;
}

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
  // P2-A (REQ-PIXEL-PARITY-1-A2) — inline talent-preview expander. Raw
  // current-episode pipeline rows grouped by requisition; the expanded row; and
  // a lazily-filled talent-name cache (per-id fetch on expand — truthful, no
  // batch endpoint yet).
  const [pipelinesByReq, setPipelinesByReq] = useState<
    Record<string, readonly PipelineView[]>
  >({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The talent slide-in panel opened from a talent card in an expanded row.
  const [selectedTalent, setSelectedTalent] = useState<OpenTalentPayload | null>(null);
  const [talentNames, setTalentNames] = useState<Record<string, string>>({});
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // No secondary chip active by default — the default list is the server-scoped
  // payload (recruiter assignment enforced by the BE; the Owner dropdown narrows).
  const [mode, setMode] = useState<FilterMode>('none');
  const [client, setClient] = useState('');
  const [statusFilter, setStatusFilter] = useState<RecruitingStatus | ''>('');
  const [sort, setSort] = useState<SortKey>('focus');
  const [query, setQuery] = useState('');
  // REQ-PIXEL-PARITY-1 (hybrid) — prototype Location + Owner dropdowns, additive
  // to the wired chips. FE-derived from the loaded set (city/state, owner ids).
  const [locationFilter, setLocationFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');

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
        // P2-A — group the current-episode rows by requisition for the expander.
        const byReq: Record<string, PipelineView[]> = {};
        for (const p of collapseToCurrentEpisode(pipeRes.value.items)) {
          (byReq[p.requisition_id] ??= []).push(p);
        }
        setPipelinesByReq(byReq);
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

  // PR-14 — personal bookmark toggle. Optimistic: flip the local row first,
  // call the server, revert on failure. This is a PERSONAL mark on the
  // CALLER's own state — it never touches is_hot and never affects another
  // user's view. The star reads the enriched `bookmarked` field the BE returns
  // per calling user.
  const toggleBookmark = (id: string, next: boolean): void => {
    setItems((prev) =>
      prev.map((r) => (r.id === id ? { ...r, bookmarked: next } : r)),
    );
    void setRequisitionBookmark(id, next).catch(() => {
      setItems((prev) =>
        prev.map((r) => (r.id === id ? { ...r, bookmarked: !next } : r)),
      );
    });
  };

  // P2-A — toggle the inline talent preview; lazily fetch the missing talent
  // names (per-id) for the row being opened. Names come from the talent SOR —
  // no fabricated data; the expander shows only real pipeline rows.
  const toggleExpand = (reqId: string): void => {
    setExpandedId((cur) => (cur === reqId ? null : reqId));
    const missing = (pipelinesByReq[reqId] ?? [])
      .map((e) => e.talent_record_id)
      .filter((id) => !(id in talentNames));
    if (missing.length === 0) return;
    void Promise.allSettled(missing.map((id) => getTalentRecord(id))).then(
      (results) => {
        const add: Record<string, string> = {};
        for (const r of results) {
          if (r.status === 'fulfilled') {
            add[r.value.id] =
              `${r.value.first_name} ${r.value.last_name}`.trim();
          }
        }
        if (Object.keys(add).length > 0) {
          setTalentNames((prev) => ({ ...prev, ...add }));
        }
      },
    );
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = items.filter((r) => {
      // D1-a — the default hides terminal statuses (closed/full/canceled) from
      // the unfiltered list; an explicit Status selection is authoritative and
      // surfaces those rows. Selecting a specific status filters to it.
      if (statusFilter === '' && isClosedStatus(r.status)) {
        return false;
      }
      if (mode === 'hot' && !r.is_hot) return false;
      // PR-14 — Bookmarked narrows to the caller's own bookmarks (personal field).
      if (mode === 'bookmarked' && !r.bookmarked) return false;
      if (client !== '' && r.company_id !== client) return false;
      if (statusFilter !== '' && r.status !== statusFilter) return false;
      if (locationFilter !== '' && locationKeyOf(r) !== locationFilter) return false;
      if (ownerFilter !== '') {
        const ownerMatch =
          ownerFilter === 'me'
            ? isMine(r)
            : r.recruiter_id === ownerFilter || r.owner_id === ownerFilter;
        if (!ownerMatch) return false;
      }
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
    mode,
    client,
    statusFilter,
    locationFilter,
    ownerFilter,
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
          return daysOpen(r) >= AGING_DAYS;
        })
        .slice(0, 6),
    [filtered, pipelineCounts],
  );

  // R5 — the summary line uses ONLY real enum values (open / on hold /
  // closed). No derived bucket, and no total implying these sum.
  const openCount = items.filter((r) => r.status === 'open').length;
  const onHoldCount = items.filter((r) => r.status === 'on_hold').length;
  const closedCount = items.filter((r) => r.status === 'closed').length;
  const readyCount = filtered.length;
  const capped = items.length >= LIST_CAP;

  // A governed pipeline transition from the panel updates the entry in place so
  // the talent card's stage pill reflects the new stage immediately.
  const handleTransitioned = (updated: PipelineView): void => {
    setPipelinesByReq((prev) => {
      const list = prev[updated.requisition_id] ?? [];
      return {
        ...prev,
        [updated.requisition_id]: list.map((x) => (x.id === updated.id ? updated : x)),
      };
    });
    setSelectedTalent((sel) => (sel ? { ...sel, entry: updated } : sel));
  };

  // A successful inline talent-field save in the side panel reports an
  // enrichment-shaped patch; reflect it in the read-only extender (every row for
  // that talent, across requisitions) + the open panel's entry — no refetch, so
  // the just-entered value is visible immediately. The extender stays read-only.
  const handleTalentFieldSaved = (
    talentRecordId: string,
    patch: Partial<PipelineView>,
  ): void => {
    setPipelinesByReq((prev) => {
      const next: Record<string, readonly PipelineView[]> = {};
      for (const [reqId, list] of Object.entries(prev)) {
        next[reqId] = list.map((x) =>
          x.talent_record_id === talentRecordId ? { ...x, ...patch } : x,
        );
      }
      return next;
    });
    setSelectedTalent((sel) =>
      sel && sel.entry.talent_record_id === talentRecordId
        ? { ...sel, entry: { ...sel.entry, ...patch } }
        : sel,
    );
  };

  return (
    <section>
      <div className="rc-viewhead">
        <h1 className="rc-h1">Requisitions</h1>
        <div className="rc-viewhead__actions">
          {/* REQ-PIXEL-PARITY-1 — prototype "Saved views". No backend yet, so it
              is DISABLED (honest coming-soon), not a dead-looking live button. */}
          <Button variant="secondary" disabled title="Saved views — coming soon">
            Saved views
          </Button>
          {canCreate ? (
            <Link to="/requisitions/new">
              <Button variant="primary">New requisition</Button>
            </Link>
          ) : null}
        </div>
      </div>

      {/* Counts (left) + results meta (right) share one row. */}
      <div className="rc-subrow">
        <p className="rc-sub">
          {openCount} open · {onHoldCount} on hold · {closedCount} closed
        </p>
        {!loading && filtered.length > 0 ? (
          <span className="rc-subrow__meta">
            {readyCount} result{readyCount === 1 ? '' : 's'} · click a row to
            preview talent
            {capped ? (
              <span> · showing your {LIST_CAP} most recent (pagination coming)</span>
            ) : null}
          </span>
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

      <Toolbar float>
        {/* Search first (prototype). Then the prototype dropdowns, then the two
            retained wired chips (Priority + Bookmarked), then Sort. */}
        <ScopedSearch
          placeholder="Search requisitions"
          value={query}
          onChange={setQuery}
        />
        <select
          className="rc-fsel"
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as RecruitingStatus | '')}
        >
          <option value="">Any status</option>
          {SELECTABLE_RECRUITING_STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {RECRUITING_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        {/* Searchable company filter (type to navigate). */}
        <span className="rc-fcombo">
          <Combobox
            ariaLabel="Filter by company"
            items={[
              { value: '', label: 'All companies' },
              ...clientOptions(items, companyNames).map((c) => ({
                value: c.id,
                label: c.name,
              })),
            ]}
            value={client === '' ? null : client}
            onSelect={(item) => setClient(item.value)}
            placeholder="All companies"
            testId="company-filter"
          />
        </span>
        <select
          className="rc-fsel"
          aria-label="Filter by location"
          value={locationFilter}
          onChange={(e) => setLocationFilter(e.target.value)}
        >
          <option value="">All locations</option>
          {locationOptions(items).map((loc) => (
            <option key={loc} value={loc}>
              {loc}
            </option>
          ))}
        </select>
        <select
          className="rc-fsel"
          aria-label="Filter by owner"
          value={ownerFilter}
          onChange={(e) => setOwnerFilter(e.target.value)}
        >
          <option value="">Any owner</option>
          {myId !== null ? <option value="me">Me</option> : null}
          {ownerFilterOptions(items, userNames)
            .filter((o) => o.id !== myId)
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
        </select>
        <FilterChip
          active={mode === 'hot'}
          onClick={() => setMode(mode === 'hot' ? 'none' : 'hot')}
        >
          Priority
        </FilterChip>
        <FilterChip
          active={mode === 'bookmarked'}
          onClick={() => setMode(mode === 'bookmarked' ? 'none' : 'bookmarked')}
        >
          Bookmarked
        </FilterChip>
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
      </Toolbar>

      <Card flush className="rc-mt-16">
        {loading ? (
          <p className="rc-empty">Loading requisitions…</p>
        ) : filtered.length === 0 ? (
          <p className="rc-empty">
            {items.length === 0
              ? 'No requisitions visible to you yet.'
              : 'No requisitions match these filters.'}
          </p>
        ) : (
          <div className="rc-rt__scroll">
            <div className="rc-rt">
              <div className="rc-rt__head" role="row">
                <span className="rc-rt__hc" aria-hidden="true" />
                <span className="rc-rt__hc">Requisition</span>
                <span className="rc-rt__hc">Talent</span>
                <span className="rc-rt__hc">Pipeline</span>
                <span className="rc-rt__hc">Capacity</span>
                <span className="rc-rt__hc">Client Status</span>
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
                  onToggleBookmark={toggleBookmark}
                  expanded={expandedId === r.id}
                  onToggle={() => toggleExpand(r.id)}
                  entries={pipelinesByReq[r.id] ?? EMPTY_ENTRIES}
                  talentNames={talentNames}
                  onOpenTalent={setSelectedTalent}
                />
              ))}
            </div>
          </div>
        )}
      </Card>
      {selectedTalent ? (
        <TalentDetailPanel
          entry={selectedTalent.entry}
          talentName={selectedTalent.talentName}
          isNew={selectedTalent.isNew}
          reqTitle={selectedTalent.reqTitle}
          reqCode={selectedTalent.reqCode}
          scopes={session?.scopes ?? []}
          onClose={() => setSelectedTalent(null)}
          onTransitioned={handleTransitioned}
          onTalentFieldSaved={handleTalentFieldSaved}
        />
      ) : null}
    </section>
  );
}

// Payload the talent card hands up to open the slide-in panel.
type OpenTalentPayload = {
  readonly entry: PipelineView;
  readonly talentName: string | undefined;
  readonly isNew: boolean;
  readonly reqTitle: string;
  readonly reqCode: string;
};

interface RequisitionRowProps {
  readonly req: RequisitionView;
  readonly companyName: string | undefined;
  readonly funnel: ReqFunnel | undefined;
  readonly ownerName: string | null;
  readonly onToggleBookmark: (id: string, next: boolean) => void;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly entries: readonly PipelineView[];
  readonly talentNames: Record<string, string>;
  readonly onOpenTalent: (payload: OpenTalentPayload) => void;
}

function RequisitionRow({
  req,
  companyName,
  funnel,
  ownerName: owner,
  onToggleBookmark,
  expanded,
  onToggle,
  entries,
  talentNames,
  onOpenTalent,
}: RequisitionRowProps) {
  const detailHref = `/requisitions/${req.id}`;
  const total = funnel?.total ?? 0;
  // Capacity (replaces the pipeline distribution bar per PO ruling + the T4-B2
  // capacity_balance read-exposure amendment). The signed capacity_balance
  // distinguishes the three truthful states — the clamped openings_available
  // alone cannot show over-capacity. Placement-derived.
  const capState =
    req.capacity_balance < 0
      ? { key: 'over', label: 'Over capacity' }
      : req.capacity_balance === 0
        ? { key: 'full', label: 'Fully consumed' }
        : { key: 'avail', label: 'Available' };
  const capTitle =
    `${req.openings} opening${req.openings === 1 ? '' : 's'} · ` +
    `${req.openings_available} available · ${capState.label}`;
  // L8-B2 — authoritative Client Status. `null` ⇒ OPEN (R-DEFAULT-OPEN), never Unknown.
  const csState =
    req.client_submittal_status === 'closed'
      ? { key: 'closed', label: 'Closed' }
      : req.client_submittal_status === 'paused'
        ? { key: 'paused', label: 'Paused' }
        : { key: 'open', label: 'Open' };
  const csReasonText =
    req.client_submittal_reason === 'deadline_passed'
      ? 'Deadline passed'
      : req.client_submittal_reason === 'limit_reached'
        ? 'Supplier limit reached'
        : req.client_submittal_reason === 'manual_hold'
          ? 'Manual/client hold'
          : req.client_submittal_reason === 'paused'
            ? 'Paused'
            : null;
  const csTitle =
    csState.key === 'open'
      ? 'Open — accepting client submittals'
      : csReasonText
        ? `${csState.label} — ${csReasonText}`
        : csState.label;
  // The identity sub-line. PR-15 self-consistency: the INTERNAL number is the
  // primary human-readable id (rendered REQ-{number}, prefix presentation-only,
  // always present) — it leads the line exactly as it does on the detail header.
  // external_req_id (the VMS id, usually null) follows as secondary where
  // present; then Company · Location. No dangling separator when either is absent.
  const idParts: ReactNode[] = [];
  idParts.push(
    <span key="reqno" className="mono">
      REQ-{req.requisition_number}
    </span>,
  );
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
    <>
    <article
      id={rowDomId(req.id)}
      className={`rc-rt__row${req.is_hot ? ' rc-rt__row--hot' : ''}${
        expanded ? ' rc-rt__row--exp' : ''
      }`}
      role="row"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {/* Leading ★ column — the personal favorite (PR-14), prototype's first
          column. It re-skins the bookmark to a star and never touches is_hot;
          the team-wide signal stays the "Priority" pill beside the title. */}
      <button
        type="button"
        className={`rc-rt__star${req.bookmarked ? ' rc-rt__star--on' : ''}`}
        aria-pressed={req.bookmarked}
        aria-label={req.bookmarked ? 'Remove bookmark' : 'Bookmark'}
        title={req.bookmarked ? 'Remove bookmark' : 'Bookmark'}
        onClick={(e) => {
          e.stopPropagation();
          onToggleBookmark(req.id, !req.bookmarked);
        }}
      >
        {req.bookmarked ? '★' : '☆'}
      </button>

      {/* Requisition */}
      <div className="rc-rt__req">
        <div className="rc-rt__top">
          <Link
            to={detailHref}
            className="rc-rt__title"
            onClick={(e) => e.stopPropagation()}
          >
            {req.title}
          </Link>
          {/* Team-wide operational priority signal (is_hot). Recruiter-facing
              label is "Priority"; the underlying flag/permission are unchanged. */}
          {req.is_hot ? (
            <span className="rc-rt__hot">Priority</span>
          ) : null}
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

      {/* Talent — total in pipeline. Downstream Submitted/Interview facts are
          owner-sourced views, not Pipeline-derived, so they are not shown here. */}
      <div className="rc-rt__stats">
        <span className="rc-stat rc-stat--lead">
          <b className="num">{total}</b>
          <span className="rc-stat__l">In pipeline</span>
        </span>
      </div>

      {/* Pipeline — the 6-bucket funnel, segmented (restored L8-B2 as its OWN
          column; Client Status is a separate column — three distinct truths). */}
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

      {/* Capacity — openings vs derived availability. Compact "avail / openings" +
          a state chip; the full phrasing rides the title tooltip. */}
      <div className="rc-rt__cap" title={capTitle}>
        <span className="rc-cap__counts">
          <b className="num">{req.openings_available}</b>
          <span className="rc-cap__sep">/</span>
          <b className="num">{req.openings}</b>
          <span className="rc-cap__unit">avail</span>
        </span>
        <span className={`rc-cap__state rc-cap__state--${capState.key}`}>
          {capState.label}
        </span>
      </div>

      {/* Client Status — authoritative SubmittalEligibility: may another client
          submittal be sent right now? A separate truth from Pipeline and Capacity. */}
      <div className="rc-rt__cs" title={csTitle}>
        <span className={`rc-cs rc-cs--${csState.key}`}>{csState.label}</span>
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
          {RECRUITING_STATUS_LABELS[req.status]}
        </StatusPill>
      </div>
    </article>

      {/* P2-A — inline talent preview (truthful subset: real pipeline rows;
          name from the talent SOR; stage from the pipeline status; NEW derived
          from created_at). No source / next-step (P2-D). */}
      {expanded ? (
        <div className="rc-texp">
          <div className="rc-texp__head">
            <span className="rc-texp__label">Talent on this requisition</span>
            <Link to={detailHref} className="rc-texp__link">
              Open full pipeline →
            </Link>
          </div>
          {entries.length > 0 ? (
            // Talent LIST. Real columns — name (SOR), stage, and the talent
            // contact/stated fields composed onto PipelineView by apps/api
            // (Aramo-Requisition-Expander-Talent-Rate-Columns): email/phone/
            // location/work-auth (talent:read; email+phone suppressed on
            // do_not_contact) + desired_rate (talent-stated). Never fabricated —
            // a genuinely absent value renders —. Each row opens the detail panel.
            <div className="rc-texp__scroll">
              <div className="rc-texp__table" role="table">
                <div className="rc-texp__thead" role="row">
                  <span className="rc-texp__thc">Talent</span>
                  <span className="rc-texp__thc">Stage</span>
                  <span className="rc-texp__thc">Email</span>
                  <span className="rc-texp__thc">Phone</span>
                  <span className="rc-texp__thc">Location</span>
                  <span className="rc-texp__thc">Work auth</span>
                  <span className="rc-texp__thc">Next step</span>
                  <span className="rc-texp__thc rc-texp__thc--r">Desired rate</span>
                </div>
                {entries.map((e) => {
                  const name = talentNames[e.talent_record_id];
                  const bucket = funnelBucket(e.status);
                  return (
                    <button
                      key={e.id}
                      type="button"
                      className="rc-texp__row"
                      onClick={() =>
                        onOpenTalent({
                          entry: e,
                          talentName: name,
                          isNew: isNewEntry(e),
                          reqTitle: req.title,
                          reqCode: `REQ-${req.requisition_number}`,
                        })
                      }
                    >
                      <span className="rc-texp__talent">
                        <Avatar name={name ?? '—'} size="sm" />
                        <span className="rc-texp__name">
                          {name ?? 'Loading…'}
                          {isNewEntry(e) ? (
                            <span className="rc-tcard__new">NEW</span>
                          ) : null}
                        </span>
                      </span>
                      <span>
                        <span
                          className={`rc-tcard__stage rc-tcard__stage--${bucket}`}
                        >
                          {PIPELINE_STATUS_LABELS[e.status]}
                        </span>
                      </span>
                      <span className="rc-texp__cell rc-texp__cell--email">
                        {e.email || '—'}
                      </span>
                      <span className="rc-texp__cell mono">{e.phone || '—'}</span>
                      <span className="rc-texp__cell">{e.location || '—'}</span>
                      <span className="rc-texp__cell">{e.work_auth || '—'}</span>
                      <span className="rc-texp__next">
                        {PIPELINE_NEXT_ACTION[e.status]}
                      </span>
                      <span className="rc-texp__cell rc-texp__cell--r mono">
                        {e.desired_rate || '—'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="rc-texp__empty">No talent in this pipeline yet.</p>
          )}
        </div>
      ) : null}
    </>
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
  if (r.is_hot) return `priority · ${age}d open`;
  return `aging · ${age}d open`;
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

// REQ-PIXEL-PARITY-1 (hybrid) — the location filter key: "City, ST" when a
// physical place is known, else the remote/hybrid arrangement. FE-derived.
function locationKeyOf(r: RequisitionView): string {
  const place = [r.city, r.state].filter(Boolean).join(', ');
  if (place) return place;
  if (r.work_arrangement === 'remote') return 'Remote';
  if (r.work_arrangement === 'hybrid') return 'Hybrid';
  return '';
}

function locationOptions(items: readonly RequisitionView[]): readonly string[] {
  const set = new Set<string>();
  for (const r of items) {
    const k = locationKeyOf(r);
    if (k !== '') set.add(k);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function ownerFilterOptions(
  items: readonly RequisitionView[],
  names: Record<string, string>,
): ReadonlyArray<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const r of items) {
    const id = r.recruiter_id ?? r.owner_id;
    if (id != null && !seen.has(id)) seen.set(id, names[id] ?? '—');
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
