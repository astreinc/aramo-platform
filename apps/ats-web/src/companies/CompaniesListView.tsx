import {
  InlineAlert,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { resolveUserNames } from '../users/users-api';
import { Avatar, Card, Icons, StatusPill, Tag } from '../ui';

import { CompanyBulkBar } from './components/CompanyBulkBar';
import { CompanyEditDrawer } from './components/CompanyEditDrawer';
import {
  getCompanyMetrics,
  searchCompanies,
  updateCompany,
} from './companies-api';
import { listErrorMessage } from './error-messages';
import type { CompanyView } from './types';
import {
  EMPTY_FACETS,
  RELATIONSHIP_TABS,
  REL_STATUS_LABELS,
  REL_STATUS_TONES,
  TIER_LABELS,
  buildCompanyQuery,
  lastContactLabel,
  locationOf,
  matchesText,
  relStatusLabel,
  relTypeLabel,
  tabCountFrom,
  tierLabel,
  type CompanyFacets,
  type CompanyMetrics,
  type FacetFlag,
  type FacetState,
  type RelationshipTab,
  type ScopeMode,
} from './company-workspace';

// Company Party/Role (ADR-0032, Slice B) — the list leads with relationship
// TYPE tabs (All / Clients / Vendors / Partners) and a relationship STATUS
// filter, reading the real relationships[] axis. The old status-derived
// "relationship" facet + the left FacetRail are retired (prototype uses the
// tab + inline pills; no left rail).
const REL_STATUS_ORDER = ['PROSPECT', 'ACTIVE', 'ON_HOLD', 'INACTIVE'] as const;

// Companies workspace — Phase 2: SERVER-SIDE pagination + facets. The list now
// pages via a keyset cursor (?paged=true) and renders server-computed facet +
// segment counts (no 50-cap). Scope (My/All), segments, and the facet rail are
// server query params; the in-list text box filters the LOADED page client-side
// (so it never needs company:search). Selection / drawer / bulk operate on the
// loaded page. Every value binds to a real CompanyView field.

const PAGE_SIZE = 50;
const FLAG_LABELS: Record<FacetFlag, string> = {
  hot: 'Hot',
  quiet: 'Quiet 30d+',
  exclusive: 'Exclusive',
  off_limits: 'Off-limits',
};

type ViewMode = 'table' | 'cards';

interface CompaniesListViewProps {
  readonly sessionOverride?: Session;
  // Company Party/Role (ADR-0032, R6) — /companies/new resolves to this
  // workspace with the create drawer already open.
  readonly initialCreate?: boolean;
}

type EditState = { readonly mode: 'create' | 'edit'; readonly company: CompanyView | null };

export function CompaniesListView({
  sessionOverride,
  initialCreate = false,
}: CompaniesListViewProps = {}) {
  const [items, setItems] = useState<readonly CompanyView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [facets, setFacets] = useState<CompanyFacets | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const [metricsById, setMetricsById] = useState<Record<string, CompanyMetrics>>(
    {},
  );

  const [scope, setScope] = useState<ScopeMode>('all');
  const [tab, setTab] = useState<RelationshipTab>('all');
  const [facetState, setFacetState] = useState<FacetState>(EMPTY_FACETS);
  const [query, setQuery] = useState('');
  const [vmode, setVmode] = useState<ViewMode>('table');

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [editState, setEditState] = useState<EditState | null>(
    initialCreate ? { mode: 'create', company: null } : null,
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const loadMoreRef = useRef<HTMLButtonElement | null>(null);

  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const myId = session?.sub ?? null;
  const canCreate =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'company:create');
  const canAssign =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'company:edit');
  const canSeeCommercial =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'company:read_commercial');

  // Owner-name resolution — one-shot admin-gated probe (graceful 403 fallback).
  useEffect(() => {
    let cancelled = false;
    void resolveUserNames().then((names) => {
      if (!cancelled) setUserNames(names);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean) => {
      const params = buildCompanyQuery({
        scope,
        tab,
        facets: facetState,
        cursor,
        pageSize: PAGE_SIZE,
      });
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const res = await searchCompanies(params);
        const pageItems = res.items ?? [];
        setItems((prev) => (append ? [...prev, ...pageItems] : [...pageItems]));
        // Tolerate a non-paged response shape ({items} only): no cursor, no
        // server facets, total falls back to the loaded count.
        setNextCursor(res.next_cursor ?? null);
        setFacets(res.facets ?? null);
        setTotal(res.total ?? pageItems.length);
        setError(null);
      } catch (err) {
        if (!append) {
          setItems([]);
          setFacets(null);
          setTotal(0);
        }
        setError(listErrorMessage(err));
      } finally {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [scope, tab, facetState],
  );

  // Debounced refetch on any server-filter change; resets page + selection.
  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      if (cancelled) return;
      setSelected(new Set());
      void fetchPage(null, false);
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [fetchPage]);

  // Per-company metrics for the loaded page — best-effort (report:read; degrades
  // to "—" on 403). `requestedMetrics` records every id we've already asked for
  // (success, miss, OR error) so we never refetch — without it, ids the server
  // returns no row for (or a 403) would loop forever.
  const requestedMetrics = useRef<Set<string>>(new Set());
  useEffect(() => {
    const missing = items
      .map((c) => c.id)
      .filter((id) => !requestedMetrics.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) requestedMetrics.current.add(id);
    let cancelled = false;
    void getCompanyMetrics(missing)
      .then((res) => {
        if (cancelled) return;
        setMetricsById((prev) => {
          const next = { ...prev };
          for (const m of res.items) next[m.company_id] = m;
          return next;
        });
      })
      .catch(() => {
        /* no report:read → metrics stay absent; columns show — */
      });
    return () => {
      cancelled = true;
    };
  }, [items]);

  // The text box filters the LOADED page (client-side; no ?q=).
  const visible = useMemo(
    () => items.filter((c) => matchesText(c, query)),
    [items, query],
  );

  const toggleStr = (
    key: 'relationship_type' | 'relationship_status' | 'tier' | 'industry',
    value: string,
  ) =>
    setFacetState((f) => {
      const arr = f[key];
      return {
        ...f,
        [key]: arr.includes(value)
          ? arr.filter((x) => x !== value)
          : [...arr, value],
      };
    });
  const toggleFlag = (value: FacetFlag) =>
    setFacetState((f) => ({
      ...f,
      flags: f.flags.includes(value)
        ? f.flags.filter((x) => x !== value)
        : [...f.flags, value],
    }));

  const resetAll = () => {
    setFacetState(EMPTY_FACETS);
    setScope('all');
    setTab('all');
    setQuery('');
  };

  const toggleSel = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const loadMore = () => {
    if (nextCursor !== null) void fetchPage(nextCursor, true);
  };

  const assignToMe = async () => {
    if (myId === null || selected.size === 0) return;
    const ids = visible.filter((c) => selected.has(c.id)).map((c) => c.id);
    setBusy(true);
    setNotice(null);
    try {
      await Promise.all(ids.map((id) => updateCompany(id, { owner_id: myId })));
      setItems((prev) =>
        prev.map((c) => (selected.has(c.id) ? { ...c, owner_id: myId } : c)),
      );
      setNotice(`Assigned ${ids.length} to you.`);
      setSelected(new Set());
    } catch {
      setNotice('Couldn’t reassign — please try again.');
    } finally {
      setBusy(false);
    }
  };

  // ── active filter chips ──
  const chips: { k: string; label: string; clear: () => void }[] = [];
  if (scope === 'mine')
    chips.push({ k: 'Scope', label: 'My accounts', clear: () => setScope('all') });
  if (tab !== 'all')
    chips.push({
      k: 'Tab',
      label: RELATIONSHIP_TABS.find((t) => t.key === tab)?.label ?? tab,
      clear: () => setTab('all'),
    });
  for (const s of facetState.relationship_status)
    chips.push({
      k: 'Status',
      label: REL_STATUS_LABELS[s] ?? s,
      clear: () => toggleStr('relationship_status', s),
    });
  for (const t of facetState.tier)
    chips.push({
      k: 'Tier',
      label: TIER_LABELS[t] ?? t,
      clear: () => toggleStr('tier', t),
    });
  for (const i of facetState.industry)
    chips.push({ k: 'Industry', label: i, clear: () => toggleStr('industry', i) });
  for (const f of facetState.flags)
    chips.push({ k: 'Flag', label: FLAG_LABELS[f], clear: () => toggleFlag(f) });

  const hasActiveQuery = chips.length > 0 || query.trim() !== '';
  // Company Party/Role (ADR-0032) — relationship-breakdown headline from the
  // server type facets (stable base-where counts).
  const relCount = (t: string): number =>
    facets?.relationship_type?.find((b) => b.value === t)?.count ?? 0;
  const headline =
    facets !== null && facets.relationship_type !== undefined
      ? `${total} ${total === 1 ? 'company' : 'companies'} · ${relCount('CLIENT')} client, ${relCount('VENDOR')} vendor, ${relCount('PARTNER')} partner relationships`
      : null;
  const editingId = editState?.company?.id ?? null;
  const openEdit = (c: CompanyView) => setEditState({ mode: 'edit', company: c });
  const openCreate = () => setEditState({ mode: 'create', company: null });
  const onSaved = () => {
    setEditState(null);
    void fetchPage(null, false);
  };
  const ownerName = (c: CompanyView): string =>
    c.owner_id ? (userNames[c.owner_id] ?? '—') : '—';

  return (
    <section
      className={editState !== null ? 'rc-talent rc-talent--drawer' : 'rc-talent'}
    >
      <div className="rc-viewhead">
        <div>
          <div className="rc-titlerow">
            <h1 className="rc-h1">Companies</h1>
            <div className="rc-scopetabs" role="group" aria-label="Scope">
              <button
                type="button"
                className={scope === 'mine' ? 'on' : ''}
                aria-pressed={scope === 'mine'}
                onClick={() => setScope('mine')}
              >
                My accounts
              </button>
              <button
                type="button"
                className={scope === 'all' ? 'on' : ''}
                aria-pressed={scope === 'all'}
                onClick={() => setScope('all')}
              >
                All
              </button>
            </div>
          </div>
          {headline !== null ? (
            <p className="rc-sub rc-sub--count">{headline}</p>
          ) : null}
          <p className="rc-sub">
            <Icons.IconShield className="rc-sub__icon" aria-hidden="true" />
            Your visible companies — the organizations you can see through
            assignments, reports, or pod-client teams.
          </p>
        </div>
        <div className="rc-viewhead__actions">
          <div className="rc-scopetabs" role="group" aria-label="View mode">
            <button
              type="button"
              className={vmode === 'table' ? 'on' : ''}
              aria-pressed={vmode === 'table'}
              onClick={() => setVmode('table')}
            >
              Table
            </button>
            <button
              type="button"
              className={vmode === 'cards' ? 'on' : ''}
              aria-pressed={vmode === 'cards'}
              onClick={() => setVmode('cards')}
            >
              Cards
            </button>
          </div>
          {canCreate ? (
            <button
              type="button"
              className="rc-hbtn rc-hbtn--primary"
              onClick={openCreate}
              data-testid="company-new"
            >
              <Icons.IconPlus /> New company
            </button>
          ) : null}
        </div>
      </div>

      {/* Relationship TYPE tabs (ADR-0032) — All / Clients / Vendors / Partners,
          with server-derived distinct-company counts. */}
      <div className="rc-views" role="group" aria-label="Relationship">
        {RELATIONSHIP_TABS.map((t) => {
          const count = tabCountFrom(facets, total, t.key);
          return (
            <button
              key={t.key}
              type="button"
              className={`rc-view${tab === t.key ? ' on' : ''}`}
              aria-pressed={tab === t.key}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              {count !== null ? (
                <span className="rc-view__ct num">{count}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Relationship STATUS filter pills (lifecycle within the active tab). */}
      <div className="rc-views" role="group" aria-label="Status">
        <span className="rc-views__lbl">Status</span>
        {REL_STATUS_ORDER.map((s) => {
          const on = facetState.relationship_status.includes(s);
          return (
            <button
              key={s}
              type="button"
              className={`rc-view${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => toggleStr('relationship_status', s)}
            >
              {relStatusLabel(s)}
            </button>
          );
        })}
      </div>

      <div className="rc-tokenbox">
        <Icons.IconSearch className="rc-tokenbox__icon" aria-hidden="true" />
        <input
          className="rc-tokenbox__input"
          type="search"
          placeholder="Filter loaded accounts by name, industry, location or tag"
          aria-label="Filter companies"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="rc-activebar">
        <span className="rc-activebar__count num">
          {visible.length}
          <small> of {total} companies</small>
        </span>
        {chips.length > 0 ? <span className="rc-activebar__sep" /> : null}
        {chips.map((c, i) => (
          <span key={`${c.k}-${c.label}-${i}`} className="rc-fchip">
            <span className="rc-fchip__k">{c.k}</span> {c.label}
            <button
              type="button"
              aria-label={`Remove ${c.k} ${c.label}`}
              onClick={c.clear}
            >
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

      <div className="rc-mt-16">
        <Card flush>
          <div className="rc-rtools">
            <span className="rc-rtools__note">
              {selected.size > 0
                ? `${selected.size} selected`
                : `${visible.length} companies`}
            </span>
          </div>

          {loading ? (
            <p className="rc-empty">Loading companies…</p>
          ) : visible.length === 0 ? (
            <p className="rc-empty">
              {hasActiveQuery
                ? 'No companies match these filters.'
                : 'No companies visible to you yet.'}
            </p>
          ) : vmode === 'cards' ? (
            <div className="rc-cocards">
              {visible.map((c) => (
                <CompanyCard
                  key={c.id}
                  company={c}
                  metrics={metricsById[c.id] ?? null}
                  onOpen={() => openEdit(c)}
                />
              ))}
            </div>
          ) : (
            <div className="rc-tablewrap">
              <table className="rc-table">
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 34 }}>
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={
                          visible.length > 0 && selected.size >= visible.length
                        }
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? new Set(visible.map((c) => c.id))
                              : new Set(),
                          )
                        }
                      />
                    </th>
                    <th scope="col">Company</th>
                    <th scope="col">Relationships</th>
                    <th scope="col">Open reqs</th>
                    <th scope="col">Active</th>
                    <th scope="col">Owner</th>
                    <th scope="col">Last contact</th>
                    <th scope="col" aria-label="Row actions" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => {
                    const tier = tierLabel(c.client_tier);
                    const subtitle = [c.industry, tier, locationOf(c)]
                      .filter((s) => s !== null && s !== '' && s !== '—')
                      .join(' · ');
                    const m = metricsById[c.id];
                    return (
                      <tr
                        key={c.id}
                        className={`rc-row--clickable${selected.has(c.id) ? ' rc-row--sel' : ''}${editingId === c.id ? ' rc-row--active' : ''}`}
                        onClick={(e) => {
                          if (
                            e.target instanceof Element &&
                            e.target.closest('a,button,input,label')
                          )
                            return;
                          openEdit(c);
                        }}
                      >
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${c.name}`}
                            checked={selected.has(c.id)}
                            onChange={() => toggleSel(c.id)}
                          />
                        </td>
                        <td>
                          <Link to={`/companies/${c.id}`} className="rc-link-strong">
                            <span className="rc-ent">
                              <Avatar name={c.name} size="sm" />
                              <span>
                                <span className="rc-ent__nm">
                                  {c.name}
                                  {c.is_hot ? (
                                    <Icons.IconFlame className="rc-ent__flame" />
                                  ) : null}
                                </span>
                                <span className="rc-ent__rl">
                                  {subtitle === '' ? '—' : subtitle}
                                </span>
                              </span>
                            </span>
                          </Link>
                        </td>
                        <td>
                          <span className="rc-relpills">
                            {(c.relationships ?? []).length === 0 ? (
                              <span className="rc-consent-stub">—</span>
                            ) : (
                              (c.relationships ?? []).map((r) => (
                                <StatusPill
                                  key={r.id}
                                  tone={REL_STATUS_TONES[r.status] ?? 'neutral'}
                                  dot
                                >
                                  {relTypeLabel(r.type)} · {relStatusLabel(r.status)}
                                </StatusPill>
                              ))
                            )}
                            {c.communication_restricted ? (
                              <StatusPill tone="danger">Do not contact</StatusPill>
                            ) : null}
                          </span>
                        </td>
                        <td className="num">
                          {m !== undefined ? (
                            m.open_reqs
                          ) : (
                            <span className="rc-consent-stub">—</span>
                          )}
                        </td>
                        <td className="num">
                          {m !== undefined ? (
                            m.active_placements
                          ) : (
                            <span className="rc-consent-stub">—</span>
                          )}
                        </td>
                        <td>{ownerName(c)}</td>
                        <td className="lastcell">{lastContactLabel(c)}</td>
                        <td>
                          <div className="rc-rowq">
                            <button
                              type="button"
                              title="Quick edit"
                              aria-label={`Quick edit ${c.name}`}
                              onClick={() => openEdit(c)}
                            >
                              <Icons.IconOpen />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {nextCursor !== null && query.trim() === '' ? (
                <div className="rc-loadmore">
                  <button
                    ref={loadMoreRef}
                    type="button"
                    className="tc-button tc-button--ghost"
                    onClick={loadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore ? 'Loading…' : 'Load more companies'}
                  </button>
                </div>
              ) : null}
            </div>
          )}

          <p className="rc-footnote">
            Companies shown are the clients visible to you through assignments,
            reports, or pod-client teams.
          </p>
        </Card>
      </div>

      <CompanyBulkBar
        count={selected.size}
        busy={busy}
        canAssign={canAssign}
        onAssignToMe={assignToMe}
        onClear={() => setSelected(new Set())}
      />

      {editState !== null ? (
        <CompanyEditDrawer
          mode={editState.mode}
          company={editState.company}
          canSeeCommercial={canSeeCommercial}
          onClose={() => setEditState(null)}
          onSaved={onSaved}
        />
      ) : null}
    </section>
  );
}

// ── Card (Cards view mode) — same data as the row, no fabricated stats. ──
function CompanyCard({
  company,
  metrics,
  onOpen,
}: {
  readonly company: CompanyView;
  readonly metrics: CompanyMetrics | null;
  readonly onOpen: () => void;
}) {
  const tier = tierLabel(company.client_tier);
  return (
    <button type="button" className="rc-cocard" onClick={onOpen}>
      <div className="rc-cocard__top">
        <Avatar name={company.name} size="md" />
        <div className="rc-cocard__id">
          <span className="rc-ent__nm">
            {company.name}
            {company.is_hot ? <Icons.IconFlame className="rc-ent__flame" /> : null}
          </span>
          <span className="rc-ent__rl">{company.industry ?? locationOf(company)}</span>
        </div>
      </div>
      <div className="rc-cocard__meta">
        {(company.relationships ?? []).map((r) => (
          <StatusPill key={r.id} tone={REL_STATUS_TONES[r.status] ?? 'neutral'} dot>
            {relTypeLabel(r.type)} · {relStatusLabel(r.status)}
          </StatusPill>
        ))}
        {company.communication_restricted ? (
          <StatusPill tone="danger">Do not contact</StatusPill>
        ) : null}
        {tier !== null ? <Tag>{tier}</Tag> : null}
      </div>
      <div className="rc-cocard__foot">
        <span className="rc-cocard__stat">
          <small>Open reqs</small>
          {metrics !== null ? metrics.open_reqs : '—'}
        </span>
        <span className="rc-cocard__stat">
          <small>Active</small>
          {metrics !== null ? metrics.active_placements : '—'}
        </span>
        <span className="rc-cocard__stat">
          <small>Last contact</small>
          {lastContactLabel(company)}
        </span>
      </div>
    </button>
  );
}
