import {
  InlineAlert,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { probeTenantUsers } from '../task/task-api';
import { Avatar, Card, Icons, StatusPill, Tag } from '../ui';

import { CompanyBulkBar } from './components/CompanyBulkBar';
import { CompanyDrawer } from './components/CompanyDrawer';
import { CompanyFacetRail } from './components/CompanyFacetRail';
import { listCompanies, updateCompany } from './companies-api';
import { listErrorMessage } from './error-messages';
import type { CompanyView } from './types';
import {
  EMPTY_FACETS,
  RELATIONSHIP_LABELS,
  RELATIONSHIP_TONES,
  SEGMENTS,
  TIER_LABELS,
  countWhere,
  deriveIndustries,
  inScope,
  inSegment,
  lastContactLabel,
  locationOf,
  matchesText,
  passesFacets,
  relationshipLabel,
  tierLabel,
  type FacetFlag,
  type FacetState,
  type ScopeMode,
  type SegmentKey,
} from './company-workspace';

// Companies workspace — rebuilt to the locked Confident-Blue mockup. A faceted
// account workspace (segments-with-counts · My/All scope · facet rail · active
// chips · Table↔Cards · preview drawer · bulk bar), mirroring the Talent list.
//
// FE-only. GET /v1/companies is D4b-visibility-resolved and NON-PAGED (capped
// 50), so segments / facets / counts / filtering are all CLIENT-SIDE over the
// loaded set — honestly bounded by the cap banner. Every value binds to a real
// CompanyView field (status→relationship, client_tier→tier, is_hot, industry,
// owner_id, last_activity_at); no fabricated health/revenue/fill-rate.

const DEFAULT_LIST_CAP = 50;
const FLAG_LABELS: Record<FacetFlag, string> = {
  hot: 'Hot',
  quiet: 'Quiet 30d+',
  exclusive: 'Exclusive',
  off_limits: 'Off-limits',
};

type ViewMode = 'table' | 'cards';

interface CompaniesListViewProps {
  // Test seam — pass a fixed session so the "+ New company" / bulk gates are
  // exercisable without mounting the real session hook (R4 precedent).
  readonly sessionOverride?: Session;
}

export function CompaniesListView({ sessionOverride }: CompaniesListViewProps = {}) {
  const [items, setItems] = useState<readonly CompanyView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userNames, setUserNames] = useState<Record<string, string>>({});

  const [scope, setScope] = useState<ScopeMode>('all');
  const [segment, setSegment] = useState<SegmentKey>('all');
  const [facets, setFacets] = useState<FacetState>(EMPTY_FACETS);
  const [query, setQuery] = useState('');
  const [vmode, setVmode] = useState<ViewMode>('table');

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [drawerIndex, setDrawerIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    listCompanies()
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(listErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Owner-name resolution — one-shot admin-gated probe (graceful 403 fallback).
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

  const scoped = useMemo(
    () => items.filter((c) => inScope(c, scope, myId)),
    [items, scope, myId],
  );
  const industries = useMemo(() => deriveIndustries(scoped), [scoped]);
  const visible = useMemo(
    () =>
      scoped.filter(
        (c) =>
          inSegment(c, segment) && passesFacets(c, facets) && matchesText(c, query),
      ),
    [scoped, segment, facets, query],
  );

  // Selection + drawer index must stay valid against the current visible set.
  useEffect(() => {
    setSelected(new Set());
    setDrawerIndex(null);
  }, [scope, segment, facets, query]);

  const segmentCount = (key: SegmentKey): number =>
    countWhere(scoped, (c) => inSegment(c, key));

  const toggleStr = (key: 'relationship' | 'tier' | 'industry', value: string) =>
    setFacets((f) => {
      const arr = f[key];
      return {
        ...f,
        [key]: arr.includes(value)
          ? arr.filter((x) => x !== value)
          : [...arr, value],
      };
    });
  const toggleFlag = (value: FacetFlag) =>
    setFacets((f) => ({
      ...f,
      flags: f.flags.includes(value)
        ? f.flags.filter((x) => x !== value)
        : [...f.flags, value],
    }));

  const resetAll = () => {
    setFacets(EMPTY_FACETS);
    setScope('all');
    setSegment('all');
    setQuery('');
  };

  const toggleSel = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
  if (segment !== 'all')
    chips.push({
      k: 'View',
      label: SEGMENTS.find((s) => s.key === segment)?.label ?? segment,
      clear: () => setSegment('all'),
    });
  for (const r of facets.relationship)
    chips.push({
      k: 'Relationship',
      label: RELATIONSHIP_LABELS[r] ?? r,
      clear: () => toggleStr('relationship', r),
    });
  for (const t of facets.tier)
    chips.push({
      k: 'Tier',
      label: TIER_LABELS[t] ?? t,
      clear: () => toggleStr('tier', t),
    });
  for (const i of facets.industry)
    chips.push({
      k: 'Industry',
      label: i,
      clear: () => toggleStr('industry', i),
    });
  for (const f of facets.flags)
    chips.push({
      k: 'Flag',
      label: FLAG_LABELS[f],
      clear: () => toggleFlag(f),
    });

  const hasActiveQuery = chips.length > 0 || query.trim() !== '';
  const truncated = items.length >= DEFAULT_LIST_CAP;
  const drawerCompany = drawerIndex !== null ? (visible[drawerIndex] ?? null) : null;
  const ownerName = (c: CompanyView): string =>
    c.owner_id ? (userNames[c.owner_id] ?? '—') : '—';

  return (
    <section
      className={drawerCompany !== null ? 'rc-talent rc-talent--drawer' : 'rc-talent'}
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
          <p className="rc-sub">
            <Icons.IconShield className="rc-sub__icon" aria-hidden="true" />
            Your visible clients — the accounts you can see through assignments,
            reports, or pod-client teams.
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
            <Link to="/companies/new" className="rc-hbtn rc-hbtn--primary">
              <Icons.IconPlus /> New company
            </Link>
          ) : null}
        </div>
      </div>

      {/* segments bar — one active at a time, with real (scoped) counts. */}
      <div className="rc-views" role="group" aria-label="Views">
        <span className="rc-views__lbl">Views</span>
        {SEGMENTS.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`rc-view${segment === s.key ? ' on' : ''}`}
            aria-pressed={segment === s.key}
            onClick={() => setSegment(s.key)}
          >
            {s.label}
            <span className="rc-view__ct num">{segmentCount(s.key)}</span>
          </button>
        ))}
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
          <small> of {scoped.length} companies</small>
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
      {truncated ? (
        <p role="status" data-testid="companies-cap-banner" className="rc-facet__note">
          Showing the first {DEFAULT_LIST_CAP} companies. More may exist beyond
          this page; cursor pagination is on the roadmap.
        </p>
      ) : null}

      <div className="rc-work rc-mt-16">
        <CompanyFacetRail
          companies={scoped}
          industries={industries}
          facets={facets}
          onToggleRelationship={(v) => toggleStr('relationship', v)}
          onToggleTier={(v) => toggleStr('tier', v)}
          onToggleIndustry={(v) => toggleStr('industry', v)}
          onToggleFlag={(v) => toggleFlag(v)}
          onReset={resetAll}
        />

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
              {visible.map((c, i) => (
                <CompanyCard
                  key={c.id}
                  company={c}
                  ownerName={ownerName(c)}
                  onOpen={() => setDrawerIndex(i)}
                />
              ))}
            </div>
          ) : (
            <div className="rc-tablewrap">
              <table className="rc-table">
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>
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
                    <th scope="col">Relationship</th>
                    <th scope="col">Tier</th>
                    <th scope="col">Industry</th>
                    <th scope="col">Owner</th>
                    <th scope="col">Last contact</th>
                    <th scope="col" aria-label="Row actions" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c, i) => {
                    const tier = tierLabel(c.client_tier);
                    return (
                      <tr
                        key={c.id}
                        className={`rc-row--clickable${selected.has(c.id) ? ' rc-row--sel' : ''}${drawerIndex === i ? ' rc-row--active' : ''}`}
                        onClick={(e) => {
                          if (
                            e.target instanceof Element &&
                            e.target.closest('a,button,input,label')
                          )
                            return;
                          setDrawerIndex(i);
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
                                  {locationOf(c)}
                                </span>
                              </span>
                            </span>
                          </Link>
                        </td>
                        <td>
                          <StatusPill
                            tone={RELATIONSHIP_TONES[c.status] ?? 'neutral'}
                            dot
                          >
                            {relationshipLabel(c.status)}
                          </StatusPill>
                        </td>
                        <td>
                          {tier !== null ? (
                            <Tag>{tier}</Tag>
                          ) : (
                            <span className="rc-consent-stub">—</span>
                          )}
                        </td>
                        <td>{c.industry ?? <span className="rc-consent-stub">—</span>}</td>
                        <td>{ownerName(c)}</td>
                        <td className="lastcell">{lastContactLabel(c)}</td>
                        <td>
                          <div className="rc-rowq">
                            <button
                              type="button"
                              title="Preview"
                              aria-label={`Preview ${c.name}`}
                              onClick={() => setDrawerIndex(i)}
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

      <CompanyDrawer
        company={drawerCompany}
        index={drawerIndex ?? 0}
        total={visible.length}
        ownerNames={userNames}
        onClose={() => setDrawerIndex(null)}
        onPrev={() =>
          setDrawerIndex((i) => (i === null ? null : Math.max(0, i - 1)))
        }
        onNext={() =>
          setDrawerIndex((i) =>
            i === null ? null : Math.min(visible.length - 1, i + 1),
          )
        }
      />
    </section>
  );
}

// ── Card (Cards view mode) — same data as the row, no fabricated stats. ──
function CompanyCard({
  company,
  ownerName,
  onOpen,
}: {
  readonly company: CompanyView;
  readonly ownerName: string;
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
        <StatusPill tone={RELATIONSHIP_TONES[company.status] ?? 'neutral'} dot>
          {relationshipLabel(company.status)}
        </StatusPill>
        {tier !== null ? <Tag>{tier}</Tag> : null}
      </div>
      <div className="rc-cocard__foot">
        <span className="rc-cocard__stat">
          <small>Owner</small>
          {ownerName}
        </span>
        <span className="rc-cocard__stat">
          <small>Last contact</small>
          {lastContactLabel(company)}
        </span>
      </div>
    </button>
  );
}
