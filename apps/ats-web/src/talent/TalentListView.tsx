import {
  ApiError,
  Button,
  Dialog,
  InlineAlert,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { Link } from 'react-router-dom';

import { addTalentToPipeline } from '../pipeline/pipeline-api';
import { listRequisitions } from '../requisitions/requisitions-api';
import type { RequisitionView } from '../requisitions/types';
import { probeTenantUsers } from '../task/task-api';
import { Avatar, Card, Icons, StagePill, StatusPill, Tag, type PillTone } from '../ui';
import type { PipelineStatus } from '../pipeline/types';

import { BulkBar } from './components/BulkBar';
import { FacetRail } from './components/FacetRail';
import { TalentTriageDrawer } from './components/TalentTriageDrawer';
import { TokenSearch } from './components/TokenSearch';
import { searchTalent, updateTalent } from './talent-api';
import { listErrorMessage, updateErrorMessage } from './error-messages';
import {
  EMPTY_FACETS,
  VIEWS,
  CROSS_SCHEMA_VIEWS,
  buildTalentQuery,
  deriveSkillCounts,
  fullName,
  locationOf,
  parseQuery,
  skillsOf,
  statedRate,
  AVAILABILITY_LABELS,
  CONSENT_LABELS,
  type FacetState,
  type ViewKey,
  type ScopeMode,
  type SearchToken,
  type SortDir,
  type SortKey,
} from './talent-workspace';
import type { CrossFacets, NativeFacets, TalentRecordView } from './types';

// Talent workspace (faceted) — SEGMENT 4d: the filter/facet/sort/pagination are
// SERVER-SIDE (?paged=true). The view sends the BE query (4a native filters +
// keyset cursor · 4c presets/scope), renders the full-set facet counts (4a/4b)
// and the cross-schema guard message, and pages via next_cursor (load-more,
// append). Preserved load-bearing behavior: POOL-OPEN framing, the R7/G3 refusal
// footer, the admin-gated Owner probe, scope-gated "New talent", the 403 message.
// Canonical vocab "Talent".

type Density = 'comfortable' | 'compact';

interface ColsState {
  readonly skills: boolean;
  readonly stage: boolean;
  readonly availability: boolean;
  readonly location: boolean;
  readonly rate: boolean;
  readonly consent: boolean;
  readonly lastActivity: boolean;
  readonly owner: boolean;
}
const COLUMN_OPTIONS: readonly [keyof ColsState, string][] = [
  ['skills', 'Skills'],
  ['stage', 'Stage'],
  ['availability', 'Availability'],
  ['location', 'Location'],
  ['rate', 'Rate'],
  ['consent', 'Consent'],
  ['lastActivity', 'Last activity'],
  ['owner', 'Owner'],
];
// Sort is NATIVE-columns only (server buildOrderBy) — no rate/last-activity (R10
// / cross-schema). The header Sort menu drives the same sortKey/sortDir as the
// clickable column headers.
const SORT_OPTIONS: readonly [SortKey, string][] = [
  ['name', 'Name'],
  ['location', 'Location'],
];

// Header dropdown — Columns toggles (mockup .btn trigger).
function ColumnsMenu({
  cols,
  setCols,
}: {
  readonly cols: ColsState;
  readonly setCols: Dispatch<SetStateAction<ColsState>>;
}) {
  return (
    <details className="rc-hmenu">
      <summary className="rc-hbtn">
        <Icons.IconColumns /> Columns
      </summary>
      <div className="rc-hmenu__body">
        {COLUMN_OPTIONS.map(([key, label]) => (
          <label key={key} className="rc-fopt">
            <input
              type="checkbox"
              checked={cols[key]}
              onChange={() => setCols((c) => ({ ...c, [key]: !c[key] }))}
            />
            {label}
          </label>
        ))}
      </div>
    </details>
  );
}

// Header dropdown — Sort by a native column + toggle direction.
function SortMenu({
  sortKey,
  sortDir,
  onSort,
}: {
  readonly sortKey: SortKey;
  readonly sortDir: SortDir;
  readonly onSort: (key: SortKey) => void;
}) {
  return (
    <details className="rc-hmenu">
      <summary className="rc-hbtn">
        <Icons.IconSort /> Sort
      </summary>
      <div className="rc-hmenu__body">
        {SORT_OPTIONS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="rc-sortopt"
            aria-pressed={sortKey === key}
            onClick={() => onSort(key)}
          >
            {label}
            <span className="rc-sortopt__dir">
              {sortKey === key ? (sortDir === 'asc' ? '↑' : '↓') : ''}
            </span>
          </button>
        ))}
      </div>
    </details>
  );
}

// Availability pill tones (a talent-stated status, never an inferred ordering; R10-clean).
const AVAILABILITY_TONE: Record<string, PillTone> = {
  available_now: 'ok',
  open_to_offers: 'info',
  not_looking: 'neutral',
  unknown: 'neutral',
};

// Consent summary tones (the contact-consent moat — a stated permission state).
const CONSENT_TONE: Record<string, PillTone> = {
  contactable: 'ok',
  expiring_lt_30d: 'warn',
  do_not_contact: 'danger',
};

function relativeActivity(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const days = Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  const w = Math.floor(days / 7);
  return w < 5 ? `${w}w ago` : `${Math.floor(days / 30)}mo ago`;
}

interface TalentListViewProps {
  readonly sessionOverride?: Session;
}

export function TalentListView({ sessionOverride }: TalentListViewProps = {}) {
  const [items, setItems] = useState<readonly TalentRecordView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [serverFacets, setServerFacets] = useState<NativeFacets | null>(null);
  const [crossFacets, setCrossFacets] = useState<CrossFacets | null>(null);
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [appendNote, setAppendNote] = useState<string | null>(null);

  const [scope, setScope] = useState<ScopeMode>('all');
  const [activeView, setActiveView] = useState<ViewKey>('all');
  const [viewCounts, setViewCounts] = useState<Partial<Record<ViewKey, string>>>(
    {},
  );
  const [facets, setFacets] = useState<FacetState>(EMPTY_FACETS);
  const [tokens, setTokens] = useState<readonly SearchToken[]>([]);
  const [draft, setDraft] = useState('');

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [drawerIndex, setDrawerIndex] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [density, setDensity] = useState<Density>('comfortable');
  const [cols, setCols] = useState<ColsState>({
    skills: true,
    stage: true,
    availability: true,
    location: true,
    rate: true,
    consent: true,
    lastActivity: true,
    owner: true,
  });
  const [busy, setBusy] = useState(false);
  const [reqDialogOpen, setReqDialogOpen] = useState(false);
  const loadMoreRef = useRef<HTMLButtonElement | null>(null);

  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const myId = session?.sub ?? null;
  const canCreate =
    session !== null && Array.isArray(session.scopes) && hasScope(session, 'talent:create');
  const canEdit =
    session !== null && Array.isArray(session.scopes) && hasScope(session, 'talent:edit');
  const isLead =
    session !== null && Array.isArray(session.scopes) && hasScope(session, 'org:manage');

  // Roster probe (Owner column resolution) — one-shot, independent of search.
  useEffect(() => {
    let cancelled = false;
    void probeTenantUsers().then((res) => {
      if (cancelled || !res.available) return;
      const names: Record<string, string> = {};
      for (const u of res.items) names[u.user_id] = u.display_name ?? u.email;
      setUserNames(names);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const parsed = useMemo(() => {
    const inDraft = parseQuery(draft);
    return { tokens: [...tokens, ...inDraft.tokens], free: inDraft.free };
  }, [tokens, draft]);

  // The fetch closure depends on every filter input, so the search effect below
  // re-runs (debounced) whenever the query changes.
  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean) => {
      const params = buildTalentQuery({
        facets,
        query: parsed,
        scope,
        view: activeView,
        sort: sortKey,
        dir: sortDir,
        cursor,
        sessionSub: myId,
      });
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const res = await searchTalent(params);
        setItems((prev) => (append ? [...prev, ...res.items] : [...res.items]));
        setNextCursor(res.next_cursor);
        setServerFacets(res.facets);
        setCrossFacets(res.cross_facets ?? null);
        setError(null);
        if (append) setAppendNote(`Loaded ${res.items.length} more talent.`);
      } catch (err) {
        if (!append) {
          setItems([]);
          setServerFacets(null);
          setCrossFacets(null);
        }
        setError(listErrorMessage(err));
      } finally {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [facets, parsed, scope, activeView, sortKey, sortDir, myId],
  );

  // Debounced refetch on any query change. Resets the page + selection.
  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      if (cancelled) return;
      setSelected(new Set());
      setDrawerIndex(null);
      setAppendNote(null);
      void fetchPage(null, false);
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [fetchPage]);

  // Real, full-set VIEW COUNTS — the size of each Views pill within the current
  // scope, independent of the ad-hoc search/facets. Native views (All /
  // Available now / My hot list) come from ONE scope-only probe's facets +
  // cross_facets.matched; the three cross-schema views each take a tiny
  // page_size=1 probe and read cross_facets.matched (the 4b/4c machinery). Over
  // the materialize guard we render "N+". Refires only when the scope changes.
  useEffect(() => {
    let cancelled = false;
    const probe = (view: ViewKey) =>
      buildTalentQuery({
        facets: EMPTY_FACETS,
        query: { tokens: [], free: '' },
        scope,
        view,
        sort: 'name',
        dir: 'asc',
        cursor: null,
        sessionSub: myId,
        pageSize: 1,
      });
    const matched = (cf: CrossFacets | undefined): string | undefined => {
      if (cf === undefined) return undefined;
      return cf.over_guard ? `${cf.guard}+` : String(cf.matched);
    };
    void (async () => {
      const [base, inTouch, needs, submitted] = await Promise.all([
        searchTalent(probe('all')).catch(() => null),
        searchTalent(probe('in_touch_6mo')).catch(() => null),
        searchTalent(probe('needs_follow_up')).catch(() => null),
        searchTalent(probe('submitted_this_week')).catch(() => null),
      ]);
      if (cancelled) return;
      const next: Partial<Record<ViewKey, string>> = {};
      if (base !== null) {
        const all = matched(base.cross_facets);
        if (all !== undefined) next.all = all;
        next.available_now = String(
          base.facets.availability.find((b) => b.value === 'available_now')
            ?.count ?? 0,
        );
        next.my_hot_list = String(base.facets.hot);
      }
      const it = inTouch && matched(inTouch.cross_facets);
      if (it) next.in_touch_6mo = it;
      const nd = needs && matched(needs.cross_facets);
      if (nd) next.needs_follow_up = nd;
      const sb = submitted && matched(submitted.cross_facets);
      if (sb) next.submitted_this_week = sb;
      setViewCounts(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, myId]);

  const skillCounts = useMemo(() => deriveSkillCounts(items), [items]);

  // a11y — after a load-more append settles, keep focus on the Load-more button
  // if more pages remain (so keyboard users don't lose their place); when the
  // last page lands the button unmounts and the aria-live note announces it.
  useEffect(() => {
    if (appendNote !== null && !loadingMore && nextCursor !== null) {
      loadMoreRef.current?.focus();
    }
  }, [appendNote, loadingMore, nextCursor]);

  // ── interaction helpers ──
  const resetAll = () => {
    setFacets(EMPTY_FACETS);
    setScope('all');
    setActiveView('all');
    setTokens([]);
    setDraft('');
  };
  const pickView = (key: ViewKey) => setActiveView(key); // one active; 'all' clears
  const pickScope = (next: ScopeMode) => setScope(next);
  const commitTokens = () => {
    const p = parseQuery(draft);
    if (p.tokens.length > 0) {
      setTokens((t) => [...t, ...p.tokens]);
      setDraft(p.free);
    }
  };
  const toggleSel = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };
  const loadMore = () => {
    if (nextCursor !== null) void fetchPage(nextCursor, true);
  };

  // ── mutations ──
  const selectedTalent = items.filter((t) => selected.has(t.id));
  const assignToMe = async () => {
    if (myId === null || selectedTalent.length === 0) return;
    setBusy(true);
    setNotice(null);
    try {
      await Promise.all(selectedTalent.map((t) => updateTalent(t.id, { owner_id: myId })));
      setItems((prev) =>
        prev.map((t) => (selected.has(t.id) ? { ...t, owner_id: myId } : t)),
      );
      setNotice(`Assigned ${selectedTalent.length} to you.`);
      setSelected(new Set());
    } catch (err) {
      setNotice(updateErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const addSelectedToReq = async (req: RequisitionView) => {
    const drawerTarget = drawerIndex !== null ? items[drawerIndex] : undefined;
    const targets = drawerTarget !== undefined ? [drawerTarget] : selectedTalent;
    setBusy(true);
    setNotice(null);
    let ok = 0;
    let skipped = 0;
    for (const t of targets) {
      try {
        await addTalentToPipeline(t.id, req.id);
        ok += 1;
      } catch (err) {
        if (err instanceof ApiError && (err.status === 409 || err.status === 422)) {
          skipped += 1;
        } else {
          setNotice('Add to req failed — please try again.');
          setBusy(false);
          return;
        }
      }
    }
    setBusy(false);
    setReqDialogOpen(false);
    setNotice(
      `Added ${ok} to ${req.title}${skipped > 0 ? ` (${skipped} already in pipeline)` : ''}.`,
    );
    if (drawerIndex === null) setSelected(new Set());
  };

  // ── active filter chips ──
  const chips: { k: string; label: string; clear: () => void }[] = [];
  if (scope === 'mine')
    chips.push({ k: 'Scope', label: 'My talent', clear: () => setScope('all') });
  if (scope === 'team')
    chips.push({ k: 'Scope', label: 'My team', clear: () => setScope('all') });
  if (activeView !== 'all')
    chips.push({
      k: 'View',
      label: VIEWS.find((v) => v.key === activeView)?.label ?? activeView,
      clear: () => setActiveView('all'),
    });
  for (const s of facets.skills)
    chips.push({
      k: 'Skill',
      label: s,
      clear: () => setFacets((f) => ({ ...f, skills: f.skills.filter((x) => x !== s) })),
    });
  for (const s of facets.sources)
    chips.push({
      k: 'Source',
      label: s,
      clear: () => setFacets((f) => ({ ...f, sources: f.sources.filter((x) => x !== s) })),
    });
  if (facets.hotOnly)
    chips.push({ k: 'Hot', label: 'Hot only', clear: () => setFacets((f) => ({ ...f, hotOnly: false })) });
  if (facets.location.trim() !== '')
    chips.push({ k: 'Location', label: facets.location, clear: () => setFacets((f) => ({ ...f, location: '' })) });
  for (const a of facets.availability)
    chips.push({
      k: 'Availability',
      label: AVAILABILITY_LABELS[a as keyof typeof AVAILABILITY_LABELS] ?? a,
      clear: () => setFacets((f) => ({ ...f, availability: f.availability.filter((x) => x !== a) })),
    });
  for (const e of facets.engagementTypes)
    chips.push({
      k: 'Engagement',
      label: e,
      clear: () => setFacets((f) => ({ ...f, engagementTypes: f.engagementTypes.filter((x) => x !== e) })),
    });

  const hasActiveQuery =
    chips.length > 0 || parsed.tokens.length > 0 || parsed.free.trim() !== '';

  const drawerTalent = drawerIndex !== null ? (items[drawerIndex] ?? null) : null;
  const colCount =
    3 +
    (cols.skills ? 1 : 0) +
    (cols.stage ? 1 : 0) +
    (cols.availability ? 1 : 0) +
    (cols.location ? 1 : 0) +
    (cols.rate ? 1 : 0) +
    (cols.consent ? 1 : 0) +
    (cols.lastActivity ? 1 : 0) +
    (cols.owner ? 1 : 0);

  return (
    <section className={drawerTalent !== null ? 'rc-talent rc-talent--drawer' : 'rc-talent'}>
      <div className="rc-viewhead">
        <div>
          {/* title row — scope sits INLINE right after the H1 (the logo now owns
              the top bar), with Columns/Sort/Add at the right end of the row. */}
          <div className="rc-titlerow">
            <h1 className="rc-h1">Talent</h1>
            <div className="rc-scopetabs" role="group" aria-label="Scope">
              <button
                type="button"
                className={scope === 'mine' ? 'on' : ''}
                aria-pressed={scope === 'mine'}
                onClick={() => pickScope('mine')}
              >
                My talent
              </button>
              <button
                type="button"
                className={scope === 'team' ? 'on' : ''}
                aria-pressed={scope === 'team'}
                onClick={() => pickScope('team')}
              >
                My team
              </button>
              <button
                type="button"
                className={scope === 'all' ? 'on' : ''}
                aria-pressed={scope === 'all'}
                onClick={() => pickScope('all')}
              >
                All
              </button>
            </div>
          </div>
          <p className="rc-sub">
            <Icons.IconShield className="rc-sub__icon" aria-hidden="true" />
            Your consented working set — talent you have permission to work.
            Sourcing is a separate, consent-governed flow.
          </p>
        </div>
        <div className="rc-viewhead__actions">
          <ColumnsMenu cols={cols} setCols={setCols} />
          <SortMenu sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          {canCreate ? (
            <Link to="/talent/new" className="rc-hbtn rc-hbtn--primary">
              <Icons.IconPlus /> Add talent
            </Link>
          ) : null}
        </div>
      </div>

      {/* views bar — one active at a time, with real full-set counts (4b/4c). */}
      <div className="rc-views" role="group" aria-label="Views">
        <span className="rc-views__lbl">Views</span>
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            className={`rc-view${activeView === v.key ? ' on' : ''}`}
            aria-pressed={activeView === v.key}
            onClick={() => pickView(v.key)}
          >
            {v.label}
            {viewCounts[v.key] !== undefined ? (
              <span className="rc-view__ct num">{viewCounts[v.key]}</span>
            ) : null}
          </button>
        ))}
        <button
          type="button"
          className="rc-view rc-view--save"
          disabled
          title="Saved views need a backend saved-view API (carry)."
        >
          <Icons.IconBookmark /> Save current view
        </button>
      </div>

      <TokenSearch
        tokens={tokens}
        draft={draft}
        onDraftChange={setDraft}
        onCommit={commitTokens}
        onRemove={(i) => setTokens((t) => t.filter((_, idx) => idx !== i))}
      />

      <div className="rc-activebar">
        <span className="rc-activebar__count num">
          {items.length}
          {viewCounts.all !== undefined ? (
            <small> of {viewCounts.all} talent</small>
          ) : (
            <small> talent{nextCursor !== null ? '+' : ''}</small>
          )}
        </span>
        {chips.length > 0 ? <span className="rc-activebar__sep" /> : null}
        {chips.map((c, i) => (
          <span key={`${c.k}-${c.label}-${i}`} className="rc-fchip">
            <span className="rc-fchip__k">{c.k}</span> {c.label}
            <button type="button" aria-label={`Remove ${c.k} ${c.label}`} onClick={c.clear}>
              <Icons.IconX />
            </button>
          </span>
        ))}
        {chips.length > 0 ? (
          <button type="button" className="rc-activebar__clear" onClick={resetAll}>
            Clear all
          </button>
        ) : null}
      </div>

      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      {notice !== null ? (
        <p role="status" className="rc-notice">
          {notice}
        </p>
      ) : null}
      <p role="status" className="rc-visually-hidden">
        {appendNote ?? ''}
      </p>

      <div className="rc-work rc-mt-16">
        <FacetRail
          facets={facets}
          skillCounts={skillCounts}
          serverFacets={serverFacets}
          crossFacets={crossFacets}
          loadedCount={items.length}
          onToggleSkill={(s) =>
            setFacets((f) => ({
              ...f,
              skills: f.skills.includes(s) ? f.skills.filter((x) => x !== s) : [...f.skills, s],
            }))
          }
          onSkillMatch={(m) => setFacets((f) => ({ ...f, skillMatch: m }))}
          onToggleSource={(s) =>
            setFacets((f) => ({
              ...f,
              sources: f.sources.includes(s) ? f.sources.filter((x) => x !== s) : [...f.sources, s],
            }))
          }
          onToggleHot={() => setFacets((f) => ({ ...f, hotOnly: !f.hotOnly }))}
          onLocation={(v) => setFacets((f) => ({ ...f, location: v }))}
          onToggleAvailability={(v) =>
            setFacets((f) => ({
              ...f,
              availability: f.availability.includes(v)
                ? f.availability.filter((x) => x !== v)
                : [...f.availability, v],
            }))
          }
          onToggleEngagement={(v) =>
            setFacets((f) => ({
              ...f,
              engagementTypes: f.engagementTypes.includes(v)
                ? f.engagementTypes.filter((x) => x !== v)
                : [...f.engagementTypes, v],
            }))
          }
          onReset={resetAll}
          isLead={isLead}
        />

        <Card flush>
          <div className="rc-rtools">
            <span className="rc-rtools__note">
              {selected.size > 0 ? `${selected.size} selected` : `${items.length} talent`}
            </span>
            <div className="rc-rtools__right">
              {/* Columns + Sort now live in the page header (.rc-viewhead__actions). */}
              <button
                type="button"
                className="rc-mini"
                onClick={() => setDensity((d) => (d === 'comfortable' ? 'compact' : 'comfortable'))}
              >
                <Icons.IconDensity /> {density === 'comfortable' ? 'Comfortable' : 'Compact'}
              </button>
            </div>
          </div>

          {loading ? (
            <p className="rc-empty">Loading talent…</p>
          ) : (
            <div className="rc-tablewrap">
              <table className={`rc-table rc-table--${density}`}>
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={items.length > 0 && selected.size >= items.length}
                        onChange={(e) =>
                          setSelected(e.target.checked ? new Set(items.map((t) => t.id)) : new Set())
                        }
                      />
                    </th>
                    <th scope="col">
                      <button
                        type="button"
                        className="rc-th-sort"
                        aria-sort={sortKey === 'name' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                        onClick={() => toggleSort('name')}
                      >
                        Talent {sortKey === 'name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                      </button>
                    </th>
                    {cols.skills ? <th scope="col">Skills</th> : null}
                    {cols.stage ? <th scope="col">Stage</th> : null}
                    {cols.availability ? <th scope="col">Availability</th> : null}
                    {cols.location ? (
                      <th scope="col">
                        <button
                          type="button"
                          className="rc-th-sort"
                          aria-sort={sortKey === 'location' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                          onClick={() => toggleSort('location')}
                        >
                          Location {sortKey === 'location' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                        </button>
                      </th>
                    ) : null}
                    {cols.rate ? <th scope="col">Rate</th> : null}
                    {cols.consent ? <th scope="col">Consent</th> : null}
                    {cols.lastActivity ? <th scope="col">Last activity</th> : null}
                    {cols.owner ? <th scope="col">Owner</th> : null}
                    <th scope="col" aria-label="Row actions" />
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr>
                      <td className="rc-table__empty" colSpan={colCount}>
                        {hasActiveQuery
                          ? 'No talent matches these filters.'
                          : 'No talent yet in this tenant pool.'}
                      </td>
                    </tr>
                  ) : (
                    items.map((t, i) => (
                      <tr
                        key={t.id}
                        className={`rc-row--clickable${selected.has(t.id) ? ' rc-row--sel' : ''}${drawerIndex === i ? ' rc-row--active' : ''}`}
                        onClick={(e) => {
                          if (e.target instanceof Element && e.target.closest('a,button,input,label')) return;
                          setDrawerIndex(i);
                        }}
                      >
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${fullName(t)}`}
                            checked={selected.has(t.id)}
                            onChange={() => toggleSel(t.id)}
                          />
                        </td>
                        <td>
                          <Link to={`/talent/${t.id}`} className="rc-link-strong">
                            <span className="rc-ent">
                              <Avatar name={fullName(t)} size="sm" />
                              <span>
                                <span className="rc-ent__nm">
                                  {fullName(t)}
                                  {t.is_hot ? <Icons.IconFlame className="rc-ent__flame" /> : null}
                                </span>
                                {t.current_employer ? (
                                  <span className="rc-ent__rl">{t.current_employer}</span>
                                ) : null}
                              </span>
                            </span>
                          </Link>
                        </td>
                        {cols.skills ? (
                          <td>
                            <span className="rc-tags">
                              {skillsOf(t).slice(0, 3).map((s) => (
                                <Tag key={s}>{s}</Tag>
                              ))}
                              {skillsOf(t).length > 3 ? (
                                <span className="rc-tag rc-tag--more">+{skillsOf(t).length - 3}</span>
                              ) : null}
                            </span>
                          </td>
                        ) : null}
                        {cols.stage ? (
                          <td>
                            {t.current_stage == null ? (
                              <span className="rc-consent-stub">—</span>
                            ) : (
                              <span title={`Req ${t.current_stage.requisition_id}`}>
                                <StagePill status={t.current_stage.stage as PipelineStatus} />
                              </span>
                            )}
                          </td>
                        ) : null}
                        {cols.availability ? (
                          <td>
                            {t.availability_status === null ? (
                              <span className="rc-consent-stub">—</span>
                            ) : (
                              <StatusPill tone={AVAILABILITY_TONE[t.availability_status] ?? 'neutral'} dot>
                                {AVAILABILITY_LABELS[t.availability_status]}
                              </StatusPill>
                            )}
                          </td>
                        ) : null}
                        {cols.location ? <td>{locationOf(t)}</td> : null}
                        {cols.rate ? <td className="num">{statedRate(t)}</td> : null}
                        {cols.consent ? (
                          <td>
                            {t.consent_summary === undefined || t.consent_summary === null ? (
                              <span className="rc-consent-stub">—</span>
                            ) : (
                              <StatusPill tone={CONSENT_TONE[t.consent_summary] ?? 'neutral'}>
                                {CONSENT_LABELS[t.consent_summary] ?? t.consent_summary}
                              </StatusPill>
                            )}
                          </td>
                        ) : null}
                        {cols.lastActivity ? (
                          <td className="lastcell">{relativeActivity(t.last_activity_at)}</td>
                        ) : null}
                        {cols.owner ? (
                          <td>{t.owner_id ? (userNames[t.owner_id] ?? '—') : '—'}</td>
                        ) : null}
                        <td>
                          <div className="rc-rowq">
                            <button
                              type="button"
                              title="Preview"
                              aria-label={`Preview ${fullName(t)}`}
                              onClick={() => setDrawerIndex(i)}
                            >
                              <Icons.IconOpen />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>

              {nextCursor !== null ? (
                <div className="rc-loadmore">
                  <button
                    ref={loadMoreRef}
                    type="button"
                    className="tc-button tc-button--ghost"
                    onClick={loadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore ? 'Loading…' : 'Load more talent'}
                  </button>
                </div>
              ) : null}
            </div>
          )}

          <p className="rc-footnote">
            Talent shown is your tenant’s consented pool. Aramo doesn’t support
            open-web talent search or bulk export — sourcing is a separate,
            consent-governed flow.
          </p>
        </Card>
      </div>

      <BulkBar
        count={selected.size}
        busy={busy}
        canAssign={canEdit}
        onAddToReq={() => setReqDialogOpen(true)}
        onAssignToMe={assignToMe}
        onClear={() => setSelected(new Set())}
      />

      <TalentTriageDrawer
        talent={drawerTalent}
        index={drawerIndex ?? 0}
        total={items.length}
        ownerNames={userNames}
        onClose={() => setDrawerIndex(null)}
        onPrev={() => setDrawerIndex((i) => (i === null ? null : Math.max(0, i - 1)))}
        onNext={() => setDrawerIndex((i) => (i === null ? null : Math.min(items.length - 1, i + 1)))}
        onAddToReq={() => setReqDialogOpen(true)}
      />

      <AddToReqDialog
        open={reqDialogOpen}
        onClose={() => setReqDialogOpen(false)}
        onPick={addSelectedToReq}
        count={drawerIndex !== null ? 1 : selectedTalent.length}
        busy={busy}
      />
    </section>
  );
}

// ── Add-to-req picker (real reqs via listRequisitions; pipeline:add per talent) ──
function AddToReqDialog({
  open,
  onClose,
  onPick,
  count,
  busy,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onPick: (req: RequisitionView) => void;
  readonly count: number;
  readonly busy: boolean;
}) {
  const [reqs, setReqs] = useState<readonly RequisitionView[]>([]);
  const [reqId, setReqId] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadErr(false);
    void listRequisitions()
      .then((r) => {
        if (cancelled) return;
        setReqs(r.items.filter((x) => x.status === 'active'));
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadErr(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const chosen = reqs.find((r) => r.id === reqId) ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Add to requisition"
      description={`Add ${count} talent to a requisition's pipeline.`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={chosen === null || busy}
            onClick={() => {
              if (chosen !== null) onPick(chosen);
            }}
          >
            Add to pipeline
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="rc-empty">Loading requisitions…</p>
      ) : loadErr ? (
        <p className="rc-empty">Couldn’t load requisitions. Please try again.</p>
      ) : reqs.length === 0 ? (
        <p className="rc-empty">No active requisitions visible to you.</p>
      ) : (
        <label className="rc-field">
          <span className="rc-field__label">Requisition</span>
          <select className="rc-select" value={reqId} onChange={(e) => setReqId(e.target.value)}>
            <option value="">Select a requisition…</option>
            {reqs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
                {r.external_req_id ? ` · ${r.external_req_id}` : ''}
              </option>
            ))}
          </select>
        </label>
      )}
    </Dialog>
  );
}
