import {
  ApiError,
  Button,
  Dialog,
  InlineAlert,
  hasScope,
  useSession,
  type Session, Checkbox, Select, IconSearch, Input,
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
import { resolveUserNames } from '../users/users-api';
import { Avatar, Card, Icons, StagePill, StatusPill, type PillTone } from '../ui';
import type { PipelineStatus } from '../pipeline/types';

import { AddToListDialog } from './components/AddToListDialog';
import { LastContactCell } from './components/LastContactCell';
import { ListsPanel } from './components/ListsPanel';
import { listTalentMemberships } from './saved-list-api';
import { BulkBar } from './components/BulkBar';
import { FilterBar } from './components/FilterBar';
import { TalentTriageDrawer } from './components/TalentTriageDrawer';
import { searchTalent } from './talent-api';
import { useDetailsAutoClose } from './use-details-auto-close';
import { listErrorMessage } from './error-messages';
import {
  EMPTY_FACETS,
  VIEWS,
  buildTalentQuery,
  deriveSkillCounts,
  fullName,
  locationOf,
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
  readonly contact: boolean;
  readonly stage: boolean;
  readonly availability: boolean;
  readonly location: boolean;
  readonly rate: boolean;
  readonly consent: boolean;
  readonly lastContacted: boolean;
  readonly lists: boolean;
}
// CRM-2 — prototype Talent columns: Talent (name + title) · Contact · Location ·
// Rate · Recruiting activity · Availability · Permission · Last contacted ·
// Lists. "Last contacted" renders a TEMPORARY "—" (authoritative contact
// date/channel/actor composition is CRM-4 — never proxied by last-activity).
// "Lists" renders "—" until the CRM-3 reverse-membership read lands (no
// fabricated membership). Skills are not shown in the list.
const COLUMN_OPTIONS: readonly [keyof ColsState, string][] = [
  ['contact', 'Contact'],
  ['location', 'Location'],
  ['rate', 'Rate'],
  ['stage', 'Recruiting activity'],
  ['availability', 'Availability'],
  ['consent', 'Permission'],
  ['lastContacted', 'Last contacted'],
  ['lists', 'Lists'],
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
  const ref = useRef<HTMLDetailsElement>(null);
  useDetailsAutoClose(ref);
  return (
    <details ref={ref} className="rc-hmenu">
      <summary className="rc-hbtn">
        <Icons.IconColumns /> Columns
      </summary>
      <div className="rc-hmenu__body">
        {COLUMN_OPTIONS.map(([key, label]) => (
          <label key={key} className="rc-fopt">
            <Checkbox
             
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
  const ref = useRef<HTMLDetailsElement>(null);
  useDetailsAutoClose(ref);
  return (
    <details ref={ref} className="rc-hmenu">
      <summary className="rc-hbtn">
        <Icons.IconSort /> Sort
      </summary>
      <div className="rc-hmenu__body">
        {SORT_OPTIONS.map(([key, label]) => (
          <Button unstyled
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
          </Button>
        ))}
      </div>
    </details>
  );
}

// Availability rendered as colored TEXT (prototype) — a talent-stated status,
// never an inferred ordering (R10-clean).
const AVAILABILITY_TEXT_TONE: Record<string, 'good' | 'warn' | 'mut'> = {
  available_now: 'good',
  open_to_offers: 'mut',
  not_looking: 'mut',
  unknown: 'mut',
};

// Permission (contact-consent) pill tones — a stated permission state.
const CONSENT_TONE: Record<string, PillTone> = {
  contactable: 'ok',
  expiring_lt_30d: 'warn',
  do_not_contact: 'danger',
};

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
  // CRM-2 — a single plain free-text Talent search (no visible key:value
  // grammar). The whole string becomes `q`, which the backend matches across
  // name/title/skill/location in one OR. Structured skill/location FILTERS stay
  // in the FilterBar below. `draft` is the raw box text.
  const [draft, setDraft] = useState('');

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [drawerIndex, setDrawerIndex] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [density, setDensity] = useState<Density>('comfortable');
  const [cols, setCols] = useState<ColsState>({
    contact: true,
    stage: true,
    availability: true,
    location: true,
    rate: true,
    consent: true,
    lastContacted: true,
    lists: true,
  });
  const [busy, setBusy] = useState(false);
  const [reqDialogOpen, setReqDialogOpen] = useState(false);
  // Horizontal filter bar (prototype parity) — shown by default; the activebar's
  // "Filters / Hide filters" toggle collapses it.
  const [filtersOpen, setFiltersOpen] = useState(true);
  // CRM-2 — the "Lists" scope tab. When active the talent workspace is replaced
  // by the Lists surface, which is a STRUCTURAL SHELL until the CRM-3 Lists UI
  // lands (no fabricated membership/empty state).
  const [listsTab, setListsTab] = useState(false);
  // CRM-2 — add-to-list modal (bulk action), unblocked by CRM-1 scope seeding.
  const [addToListOpen, setAddToListOpen] = useState(false);
  // CRM-3 — the "Lists" column: visibility-scoped reverse membership for the
  // loaded page (backend-filtered; never fetch-all-and-filter in React).
  const [membershipsByTalent, setMembershipsByTalent] = useState<
    Record<string, ReadonlyArray<{ id: string; name: string; visibility: string }>>
  >({});
  const loadMoreRef = useRef<HTMLButtonElement | null>(null);

  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const myId = session?.sub ?? null;
  const canCreate =
    session !== null && Array.isArray(session.scopes) && hasScope(session, 'talent:create');
  // CRM-2 — "Add to list" bulk action requires saved-list:edit (CRM-1 seeded).
  const canManageLists =
    session !== null && Array.isArray(session.scopes) && hasScope(session, 'saved-list:edit');

  // Roster probe (Owner column resolution) — one-shot, independent of search.
  useEffect(() => {
    let cancelled = false;
    void resolveUserNames().then((names) => {
      if (!cancelled) setUserNames(names);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // CRM-2 — the free-text box is NOT tokenized: the raw string is the free query
  // (no name:/skill:/loc: grammar). tokens stays empty.
  const parsed = useMemo(
    () => ({ tokens: [] as readonly SearchToken[], free: draft }),
    [draft],
  );

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

  // CRM-3 — Lists column: one batch, visibility-scoped reverse-membership read
  // for the loaded page. Fail-soft (no column rather than a hard error).
  useEffect(() => {
    if (items.length === 0) {
      setMembershipsByTalent({});
      return;
    }
    let cancelled = false;
    void listTalentMemberships(items.map((t) => t.id))
      .then((rows) => {
        if (cancelled) return;
        const m: Record<
          string,
          ReadonlyArray<{ id: string; name: string; visibility: string }>
        > = {};
        for (const r of rows) m[r.item_id] = r.lists;
        setMembershipsByTalent(m);
      })
      .catch(() => {
        if (!cancelled) setMembershipsByTalent({});
      });
    return () => {
      cancelled = true;
    };
  }, [items]);

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
      // CRM-2 — only the four prototype quick filters. `needs_follow_up` is the
      // one cross-schema count; `not_contacted_90d` is pending (CRM-4) so it
      // carries no count.
      const [base, needs] = await Promise.all([
        searchTalent(probe('all')).catch(() => null),
        searchTalent(probe('needs_follow_up')).catch(() => null),
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
      }
      const nd = needs && matched(needs.cross_facets);
      if (nd) next.needs_follow_up = nd;
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
    setDraft('');
  };
  const pickView = (key: ViewKey) => setActiveView(key); // one active; 'all' clears
  const pickScope = (next: ScopeMode) => setScope(next);
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
  // CRM-2 — "Assign to me" was retired from the Talent bulk bar (owner_id is
  // provenance, not relationship ownership). The bulk actions are Add-to-list
  // and Add-to-requisition.
  const selectedTalent = items.filter((t) => selected.has(t.id));

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
  if (scope === 'working_with_me')
    chips.push({ k: 'Scope', label: 'Working with me', clear: () => setScope('all') });
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
    chips.length > 0 || parsed.free.trim() !== '';

  const drawerTalent = drawerIndex !== null ? (items[drawerIndex] ?? null) : null;
  const colCount =
    2 +
    (cols.contact ? 1 : 0) +
    (cols.stage ? 1 : 0) +
    (cols.availability ? 1 : 0) +
    (cols.location ? 1 : 0) +
    (cols.rate ? 1 : 0) +
    (cols.consent ? 1 : 0) +
    (cols.lastContacted ? 1 : 0) +
    (cols.lists ? 1 : 0) +
    1;

  return (
    <section className={drawerTalent !== null ? 'rc-talent rc-talent--drawer' : 'rc-talent'}>
      <div className="rc-viewhead">
        <div>
          {/* title row — scope sits INLINE right after the H1 (the logo now owns
              the top bar), with Columns/Sort/Add at the right end of the row. */}
          <div className="rc-titlerow">
            <h1 className="rc-h1">Talent</h1>
            {/* CRM-2 — prototype scope tabs: All talent / Working with me / Lists.
                "Lists" switches to the Lists surface (structural shell until the
                CRM-3 Lists UI lands). "My talent"/"My team" retired. */}
            <div className="rc-scopetabs" role="group" aria-label="Scope">
              <Button unstyled
                type="button"
                className={!listsTab && scope === 'all' ? 'on' : ''}
                aria-pressed={!listsTab && scope === 'all'}
                onClick={() => {
                  setListsTab(false);
                  pickScope('all');
                }}
              >
                All talent
              </Button>
              <Button unstyled
                type="button"
                className={!listsTab && scope === 'working_with_me' ? 'on' : ''}
                aria-pressed={!listsTab && scope === 'working_with_me'}
                onClick={() => {
                  setListsTab(false);
                  pickScope('working_with_me');
                }}
              >
                Working with me
              </Button>
              <Button unstyled
                type="button"
                className={listsTab ? 'on' : ''}
                aria-pressed={listsTab}
                onClick={() => setListsTab(true)}
              >
                Lists
              </Button>
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

      {/* CRM-2 — the "Lists" tab replaces the talent workspace with the Lists
          surface, a STRUCTURAL SHELL until the CRM-3 Lists UI lands (no
          fabricated membership/empty state). */}
      {listsTab ? (
        <ListsPanel sessionOverride={session ?? undefined} />
      ) : (
      <>
      {/* CRM-2 — quick-filter bar: exactly four chips (prototype). The pending
          chip (Not contacted 90+ days) renders disabled — its authoritative
          last-contact behavior activates in CRM-4 (never proxied by activity). */}
      <div className="rc-views" role="group" aria-label="Quick filters">
        <span className="rc-views__lbl">Quick filters</span>
        {VIEWS.map((v) => (
          <Button unstyled
            key={v.key}
            type="button"
            className={`rc-view${activeView === v.key ? ' on' : ''}${v.pending ? ' rc-view--pending' : ''}`}
            aria-pressed={activeView === v.key}
            disabled={v.pending === true}
            onClick={() => {
              if (v.pending === true) return;
              pickView(v.key);
            }}
          >
            {v.label}
            {viewCounts[v.key] !== undefined ? (
              <span className="rc-view__ct num">{viewCounts[v.key]}</span>
            ) : null}
          </Button>
        ))}
      </div>

      {/* CRM-2 — one ordinary Talent-only search box (shared rc-tokenbox chrome);
          no visible query grammar, separate from the global ⌘K. */}
      <div className="rc-tokenbox">
        <IconSearch className="rc-tokenbox__icon" aria-hidden="true" />
        <Input unstyled
          className="rc-tokenbox__input"
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Search talent by name, title, skill, or location"
          aria-label="Search talent by name, title, skill, or location"
        />
        <span className="rc-tokenbox__hint" aria-hidden="true">
          Talent only
        </span>
      </div>

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
            <Button type="button" aria-label={`Remove ${c.k} ${c.label}`} onClick={c.clear}>
              <Icons.IconX />
            </Button>
          </span>
        ))}
        {chips.length > 0 ? (
          <Button unstyled type="button" className="rc-activebar__clear" onClick={resetAll}>
            Clear all
          </Button>
        ) : null}
        <Button unstyled
          type="button"
          className={`rc-hbtn${filtersOpen ? ' rc-hbtn--on' : ''}`}
          style={{ marginLeft: 'auto' }}
          aria-pressed={filtersOpen}
          onClick={() => setFiltersOpen((o) => !o)}
        >
          <Icons.IconFilter /> {filtersOpen ? 'Hide filters' : 'Filters'}
        </Button>
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

      {filtersOpen ? (
        <FilterBar
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
        />
      ) : null}

      <Card flush>
          <div className="rc-rtools">
            <span className="rc-rtools__note">
              {selected.size > 0 ? `${selected.size} selected` : `${items.length} talent`}
            </span>
            <div className="rc-rtools__right">
              {/* Columns + Sort now live in the page header (.rc-viewhead__actions). */}
              <Button unstyled
                type="button"
                className="rc-mini"
                onClick={() => setDensity((d) => (d === 'comfortable' ? 'compact' : 'comfortable'))}
              >
                <Icons.IconDensity /> {density === 'comfortable' ? 'Comfortable' : 'Compact'}
              </Button>
            </div>
          </div>

          {loading ? (
            <p className="rc-empty">Loading talent…</p>
          ) : (
            <div className="rc-tablewrap">
              <table className={`rc-table rc-table--${density}`}>
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 34 }}>
                      <Checkbox
                       
                        aria-label="Select all"
                        checked={items.length > 0 && selected.size >= items.length}
                        onChange={(e) =>
                          setSelected(e.target.checked ? new Set(items.map((t) => t.id)) : new Set())
                        }
                      />
                    </th>
                    <th scope="col">
                      <Button unstyled
                        type="button"
                        className="rc-th-sort"
                        aria-sort={sortKey === 'name' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                        onClick={() => toggleSort('name')}
                      >
                        Talent {sortKey === 'name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                      </Button>
                    </th>
                    {cols.contact ? <th scope="col">Contact</th> : null}
                    {cols.location ? (
                      <th scope="col">
                        <Button unstyled
                          type="button"
                          className="rc-th-sort"
                          aria-sort={sortKey === 'location' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                          onClick={() => toggleSort('location')}
                        >
                          Location {sortKey === 'location' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                        </Button>
                      </th>
                    ) : null}
                    {cols.rate ? <th scope="col">Rate</th> : null}
                    {cols.stage ? <th scope="col">Recruiting activity</th> : null}
                    {cols.availability ? <th scope="col">Availability</th> : null}
                    {cols.consent ? <th scope="col">Permission</th> : null}
                    {cols.lastContacted ? <th scope="col">Last contacted</th> : null}
                    {cols.lists ? <th scope="col">Lists</th> : null}
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
                          <Checkbox
                           
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
                                {(t.title ?? t.current_employer) ? (
                                  <span className="rc-ent__sub">{t.title ?? t.current_employer}</span>
                                ) : null}
                              </span>
                            </span>
                          </Link>
                        </td>
                        {cols.contact ? (
                          <td>
                            <span className="rc-contact__em">{t.email1 ?? '—'}</span>
                            {t.phone_cell ? (
                              <span className="rc-contact__ph">{t.phone_cell}</span>
                            ) : null}
                          </td>
                        ) : null}
                        {cols.location ? <td>{locationOf(t)}</td> : null}
                        {cols.rate ? <td className="rc-num">{statedRate(t)}</td> : null}
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
                              <span
                                className={`rc-avail rc-avail--${AVAILABILITY_TEXT_TONE[t.availability_status] ?? 'mut'}`}
                              >
                                {AVAILABILITY_LABELS[t.availability_status]}
                              </span>
                            )}
                          </td>
                        ) : null}
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
                        {cols.lastContacted ? (
                          // CRM-4 — authoritative last-contact (date · channel ·
                          // actor); "Never" when none. NEVER proxied by activity.
                          <td className="lastcell">
                            <LastContactCell
                              last={t.last_contact ?? null}
                              userNames={userNames}
                              myId={myId}
                            />
                          </td>
                        ) : null}
                        {cols.lists ? (
                          // CRM-3 — visibility-scoped list membership (first list
                          // + "+n"); "—" when the talent is in no visible list.
                          <td>
                            {(() => {
                              const ls = membershipsByTalent[t.id] ?? [];
                              const first = ls[0];
                              if (first === undefined)
                                return <span className="rc-muted">—</span>;
                              return (
                                <span className="rc-listcell">
                                  <span className="rc-listcell__nm">{first.name}</span>
                                  {ls.length > 1 ? (
                                    <span className="rc-listcell__more">
                                      +{ls.length - 1}
                                    </span>
                                  ) : null}
                                </span>
                              );
                            })()}
                          </td>
                        ) : null}
                        <td>
                          <div className="rc-rowq">
                            <Button
                              type="button"
                              title="Preview"
                              aria-label={`Preview ${fullName(t)}`}
                              onClick={() => setDrawerIndex(i)}
                            >
                              <Icons.IconOpen />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>

              {nextCursor !== null ? (
                <div className="rc-loadmore">
                  <Button unstyled
                    ref={loadMoreRef}
                    type="button"
                    className="tc-button tc-button--ghost"
                    onClick={loadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore ? 'Loading…' : 'Load more talent'}
                  </Button>
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
      </>
      )}

      <BulkBar
        count={selected.size}
        busy={busy}
        canManageLists={canManageLists}
        onAddToList={() => setAddToListOpen(true)}
        onAddToReq={() => setReqDialogOpen(true)}
        onClear={() => setSelected(new Set())}
      />

      <AddToListDialog
        open={addToListOpen}
        onClose={() => setAddToListOpen(false)}
        talentIds={[...selected]}
        onDone={(message) => {
          setNotice(message);
          setSelected(new Set());
        }}
        onViewList={() => setListsTab(true)}
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
        setReqs(r.items.filter((x) => x.status === 'open'));
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
          <Select unstyled className="rc-select" value={reqId} onChange={(e) => setReqId(e.target.value)}>
            <option value="">Select a requisition…</option>
            {reqs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
                {r.external_req_id ? ` · ${r.external_req_id}` : ''}
              </option>
            ))}
          </Select>
        </label>
      )}
    </Dialog>
  );
}
