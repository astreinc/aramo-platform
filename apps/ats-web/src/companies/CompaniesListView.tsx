import {
  InlineAlert,
  hasScope,
  useSession,
  type Session, Button, Input, Select,
} from '@aramo/fe-foundation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { resolveUserNames } from '../users/users-api';
import { searchContacts } from '../contacts/contacts-api';
import { Avatar, Card, Icons, StatusPill } from '../ui';

import { CompanyEditDrawer } from './components/CompanyEditDrawer';
import { getCompanyMetrics, searchCompanies } from './companies-api';
import { listErrorMessage } from './error-messages';
import type { CompanyView } from './types';
import {
  EMPTY_FACETS,
  RELATIONSHIP_TABS,
  REL_STATUS_LABELS,
  REL_STATUS_TONES,
  TIER_LABELS,
  buildCompanyQuery,
  locationOf,
  matchesText,
  relStatusLabel,
  relTypeLabel,
  tabCountFrom,
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
  // Primary contact per company (list "Primary contact" column) — best-effort,
  // degrades to "—" without contact:read. One primary per company.
  const [primaryById, setPrimaryById] = useState<
    Record<string, { name: string; title: string | null }>
  >({});

  const [scope, setScope] = useState<ScopeMode>('all');
  const [tab, setTab] = useState<RelationshipTab>('all');
  const [facetState, setFacetState] = useState<FacetState>(EMPTY_FACETS);
  const [query, setQuery] = useState('');
  const [editState, setEditState] = useState<EditState | null>(
    initialCreate ? { mode: 'create', company: null } : null,
  );
  const loadMoreRef = useRef<HTMLButtonElement | null>(null);

  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canCreate =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'company:create');
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

  // Debounced refetch on any server-filter change; resets the page.
  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      if (cancelled) return;
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

  // Primary contact per loaded company — best-effort (contact:read; one batched,
  // visibility-scoped read via ?company_id=<page>&is_primary=true). Deduped like
  // metrics so ids are never refetched; degrades to "—" on 403.
  const requestedPrimary = useRef<Set<string>>(new Set());
  useEffect(() => {
    const missing = items
      .map((c) => c.id)
      .filter((id) => !requestedPrimary.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) requestedPrimary.current.add(id);
    let cancelled = false;
    const params = new URLSearchParams({
      paged: 'true',
      is_primary: 'true',
      company_id: missing.join(','),
      page_size: String(Math.min(missing.length, 200)),
    });
    void searchContacts(params)
      .then((page) => {
        if (cancelled) return;
        setPrimaryById((prev) => {
          const next = { ...prev };
          for (const ct of page.items) {
            const name = `${ct.first_name} ${ct.last_name}`.trim();
            next[ct.company_id] = { name, title: ct.title ?? null };
          }
          return next;
        });
      })
      .catch(() => {
        /* no contact:read → primary contact stays absent; column shows — */
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

  const loadMore = () => {
    if (nextCursor !== null) void fetchPage(nextCursor, true);
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
  // Open-reqs total is summed from the metrics loaded so far (grows as pages
  // load); tenants that fit one page show the exact tenant-wide total.
  const openReqsTotal = Object.values(metricsById).reduce(
    (sum, m) => sum + m.open_reqs,
    0,
  );
  const headline =
    facets !== null && facets.relationship_type !== undefined
      ? `${total} ${total === 1 ? 'company' : 'companies'} · ${relCount('CLIENT')} client, ${relCount('VENDOR')} vendor, ${relCount('PARTNER')} partner relationships · ${openReqsTotal} open reqs`
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
          <h1 className="rc-h1">Companies</h1>
          {headline !== null ? (
            <p className="rc-sub rc-sub--count">{headline}</p>
          ) : null}
        </div>
        <div className="rc-viewhead__actions">
          {canCreate ? (
            <Button unstyled
              type="button"
              className="rc-hbtn rc-hbtn--primary"
              onClick={openCreate}
              data-testid="company-new"
            >
              <Icons.IconPlus /> New company
            </Button>
          ) : null}
        </div>
      </div>

      {/* Relationship TYPE tabs (ADR-0032) — All / Clients / Vendors / Partners,
          with server-derived distinct-company counts. */}
      <div className="rc-views" role="group" aria-label="Relationship">
        {RELATIONSHIP_TABS.map((t) => {
          const count = tabCountFrom(facets, total, t.key);
          return (
            <Button unstyled
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
            </Button>
          );
        })}
      </div>

      {/* One-line filter row (prototype): search + relationship-status / industry /
          owner dropdowns + result count. Owner maps to the scope query (Me=mine,
          Anyone=all); status/industry are single-select server facets. */}
      <div className="rc-cofilters">
        <div className="rc-tokenbox rc-cofilters__search">
          <Icons.IconSearch className="rc-tokenbox__icon" aria-hidden="true" />
          <Input unstyled
            className="rc-tokenbox__input"
            type="search"
            placeholder="Search companies"
            aria-label="Search companies"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Select unstyled
          className="rc-filterpill"
          aria-label="Relationship status"
          value={facetState.relationship_status[0] ?? ''}
          onChange={(e) =>
            setFacetState((f) => ({
              ...f,
              relationship_status: e.target.value === '' ? [] : [e.target.value],
            }))
          }
        >
          <option value="">Relationship status: Any</option>
          {REL_STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {relStatusLabel(s)}
            </option>
          ))}
        </Select>
        <Select unstyled
          className="rc-filterpill"
          aria-label="Industry"
          value={facetState.industry[0] ?? ''}
          onChange={(e) =>
            setFacetState((f) => ({
              ...f,
              industry: e.target.value === '' ? [] : [e.target.value],
            }))
          }
        >
          <option value="">Industry: Any</option>
          {(facets?.industry ?? []).map((b) => (
            <option key={b.value} value={b.value}>
              {b.value}
            </option>
          ))}
        </Select>
        <Select unstyled
          className="rc-filterpill"
          aria-label="Owner"
          value={scope}
          onChange={(e) => setScope(e.target.value === 'mine' ? 'mine' : 'all')}
        >
          <option value="all">Owner: Anyone</option>
          <option value="mine">Owner: Me</option>
        </Select>
        <span className="rc-cofilters__result">
          {visible.length} {visible.length === 1 ? 'company' : 'companies'} · click
          a row for details
        </span>
      </div>

      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}

      <div className="rc-mt-16">
        <Card flush>
          {loading ? (
            <p className="rc-empty">Loading companies…</p>
          ) : visible.length === 0 ? (
            <p className="rc-empty">
              {hasActiveQuery
                ? 'No companies match these filters.'
                : 'No companies visible to you yet.'}
            </p>
          ) : (
            <div className="rc-tablewrap">
              <table className="rc-table rc-cotable">
                <thead>
                  <tr>
                    <th scope="col">Company</th>
                    <th scope="col">Relationships · status</th>
                    <th scope="col">Primary contact</th>
                    <th scope="col" className="num">Open reqs</th>
                    <th scope="col" className="num">Placements</th>
                    <th scope="col">Phone</th>
                    <th scope="col">Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => {
                    const subtitle = [c.industry, locationOf(c)]
                      .filter((s) => s !== null && s !== '' && s !== '—')
                      .join(' · ');
                    const m = metricsById[c.id];
                    const pc = primaryById[c.id];
                    const owner = ownerName(c);
                    return (
                      <tr
                        key={c.id}
                        className={`rc-row--clickable${editingId === c.id ? ' rc-row--active' : ''}`}
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
                        <td>
                          {pc !== undefined ? (
                            <span className="rc-copc">
                              <span className="rc-copc__nm">{pc.name}</span>
                              {pc.title ? (
                                <span className="rc-copc__ti">{pc.title}</span>
                              ) : null}
                            </span>
                          ) : (
                            <span className="rc-consent-stub">—</span>
                          )}
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
                        <td className="rc-cophone">
                          {c.phone1 !== null && c.phone1 !== '' ? (
                            c.phone1
                          ) : (
                            <span className="rc-consent-stub">—</span>
                          )}
                        </td>
                        <td>
                          {owner === '—' ? (
                            <span className="rc-consent-stub">—</span>
                          ) : (
                            <span title={owner}>
                              <Avatar name={owner} size="sm" />
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {nextCursor !== null && query.trim() === '' ? (
                <div className="rc-loadmore">
                  <Button unstyled
                    ref={loadMoreRef}
                    type="button"
                    className="tc-button tc-button--ghost"
                    onClick={loadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore ? 'Loading…' : 'Load more companies'}
                  </Button>
                </div>
              ) : null}
            </div>
          )}

          <p className="rc-footnote">
            A company is an organization; each relationship (Client · Vendor ·
            Partner) carries its own status. <b>Do not contact</b> is the only
            company-wide flag and overrides every relationship. A company holding
            two relationships appears under both tabs.
          </p>
        </Card>
      </div>

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

