import {
  ApiError,
  Button,
  Dialog,
  InlineAlert,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { addTalentToPipeline } from '../pipeline/pipeline-api';
import { listRequisitions } from '../requisitions/requisitions-api';
import type { RequisitionView } from '../requisitions/types';
import { probeTenantUsers } from '../task/task-api';
import { Avatar, Card, Icons, StatusPill, Tag, type PillTone } from '../ui';

import { BulkBar } from './components/BulkBar';
import { FacetRail } from './components/FacetRail';
import { TalentTriageDrawer } from './components/TalentTriageDrawer';
import { TokenSearch } from './components/TokenSearch';
import { listTalent, updateTalent } from './talent-api';
import { listErrorMessage, updateErrorMessage } from './error-messages';
import {
  EMPTY_FACETS,
  SAVED_VIEWS,
  applyFilters,
  deriveFacets,
  fullName,
  locationOf,
  parseQuery,
  skillsOf,
  sortTalent,
  statedRate,
  AVAILABILITY_LABELS,
  ENGAGEMENT_LABELS,
  type FacetState,
  type ScopeMode,
  type SearchToken,
  type SortDir,
  type SortKey,
} from './talent-workspace';
import type { TalentRecordView } from './types';

// Talent workspace (faceted) — the enterprise rebuild of the Talent list to the
// approved prototype's interaction contract, wired to REAL data where the
// substrate supports it and HONESTLY STUBBED (disabled + carry note) where it
// does not. Canonical vocab "Talent" (the prototype's page title is a vocab
// violation per DDR §9 / CI Tier-2; reconciled to Talent). Preserved
// load-bearing behavior: POOL-OPEN
// framing, the R7/G3 refusal footer, the cap banner, the admin-gated Owner
// probe, scope-gated "New talent", and the 403 message.
//
// Backable: rows (GET /v1/talent-records, capped 50), Owner (roster probe),
// Skills/Source/Hot/Location facets + token search (CLIENT-SIDE over the loaded
// page — counts are "within loaded"), Add-to-req (pipeline:add), Assign-to-me
// (talent:edit), drawer pipeline/activity reads, full-profile route.
// Stubbed (flagged): status/availability/rate-range/engagement/last-activity/
// consent facets+columns, saved smart-lists + Save-view, "My team" scope,
// Add-to-list/Tag/Start-engagement bulk actions, Export (permanent moat).

const DEFAULT_LIST_CAP = 50;
type Density = 'comfortable' | 'compact';

// Availability pill tones (a talent-stated status, never an inferred ordering; R10-clean).
const AVAILABILITY_TONE: Record<string, PillTone> = {
  available_now: 'ok',
  open_to_offers: 'info',
  not_looking: 'neutral',
  unknown: 'neutral',
};

interface TalentListViewProps {
  readonly sessionOverride?: Session;
}

export function TalentListView({ sessionOverride }: TalentListViewProps = {}) {
  const [items, setItems] = useState<readonly TalentRecordView[]>([]);
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [scope, setScope] = useState<ScopeMode>('all');
  const [activeView, setActiveView] = useState('all');
  const [facets, setFacets] = useState<FacetState>(EMPTY_FACETS);
  const [tokens, setTokens] = useState<readonly SearchToken[]>([]);
  const [draft, setDraft] = useState('');

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [drawerIndex, setDrawerIndex] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [density, setDensity] = useState<Density>('comfortable');
  const [cols, setCols] = useState({
    skills: true,
    availability: true,
    location: true,
    rate: true,
    consent: true,
    owner: true,
  });
  const [busy, setBusy] = useState(false);
  const [reqDialogOpen, setReqDialogOpen] = useState(false);

  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const myId = session?.sub ?? null;
  const canCreate =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'talent:create');
  const canEdit =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'talent:edit');
  const isLead =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'org:manage');

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([listTalent(), probeTenantUsers()]).then(
      ([talentRes, rosterRes]) => {
        if (cancelled) return;
        if (talentRes.status === 'fulfilled') {
          setItems(talentRes.value.items);
        } else {
          setError(listErrorMessage(talentRes.reason));
        }
        if (rosterRes.status === 'fulfilled' && rosterRes.value.available) {
          const names: Record<string, string> = {};
          for (const u of rosterRes.value.items) {
            names[u.user_id] = u.display_name ?? u.email;
          }
          setUserNames(names);
        }
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const derived = useMemo(() => deriveFacets(items), [items]);

  const query = useMemo(() => {
    const inDraft = parseQuery(draft);
    return { tokens: [...tokens, ...inDraft.tokens], free: inDraft.free };
  }, [tokens, draft]);

  const filtered = useMemo(() => {
    const base = applyFilters(items, {
      facets,
      query,
      scope,
      sessionSub: myId,
      ownerNames: userNames,
    });
    return sortTalent(base, sortKey, sortDir, userNames);
  }, [items, facets, query, scope, myId, userNames, sortKey, sortDir]);

  const truncated = items.length >= DEFAULT_LIST_CAP;

  // ── interaction helpers ──
  const resetAll = () => {
    setFacets(EMPTY_FACETS);
    setScope('all');
    setActiveView('all');
    setTokens([]);
    setDraft('');
  };
  const pickView = (key: string, backable: boolean) => {
    if (!backable) return;
    setActiveView(key);
    if (key === 'all') resetAll();
    else if (key === 'mine') setScope('mine');
    else if (key === 'hot') setFacets((f) => ({ ...f, hotOnly: true }));
  };
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

  // ── mutations ──
  const selectedTalent = filtered.filter((t) => selected.has(t.id));
  const assignToMe = async () => {
    if (myId === null || selectedTalent.length === 0) return;
    setBusy(true);
    setNotice(null);
    try {
      await Promise.all(
        selectedTalent.map((t) => updateTalent(t.id, { owner_id: myId })),
      );
      setItems((prev) =>
        prev.map((t) =>
          selected.has(t.id) ? { ...t, owner_id: myId } : t,
        ),
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
    const drawerTarget =
      drawerIndex !== null ? filtered[drawerIndex] : undefined;
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
        // already-in-pipeline / conflict is benign; count + continue
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
  for (const s of facets.skills)
    chips.push({
      k: 'Skill',
      label: s,
      clear: () =>
        setFacets((f) => ({ ...f, skills: f.skills.filter((x) => x !== s) })),
    });
  for (const s of facets.sources)
    chips.push({
      k: 'Source',
      label: s,
      clear: () =>
        setFacets((f) => ({ ...f, sources: f.sources.filter((x) => x !== s) })),
    });
  if (facets.hotOnly)
    chips.push({
      k: 'Hot',
      label: 'Hot only',
      clear: () => setFacets((f) => ({ ...f, hotOnly: false })),
    });
  if (facets.location.trim() !== '')
    chips.push({
      k: 'Location',
      label: facets.location,
      clear: () => setFacets((f) => ({ ...f, location: '' })),
    });
  for (const a of facets.availability)
    chips.push({
      k: 'Availability',
      label: AVAILABILITY_LABELS[a as keyof typeof AVAILABILITY_LABELS] ?? a,
      clear: () =>
        setFacets((f) => ({
          ...f,
          availability: f.availability.filter((x) => x !== a),
        })),
    });
  for (const e of facets.engagementTypes)
    chips.push({
      k: 'Engagement',
      label: ENGAGEMENT_LABELS[e as keyof typeof ENGAGEMENT_LABELS] ?? e,
      clear: () =>
        setFacets((f) => ({
          ...f,
          engagementTypes: f.engagementTypes.filter((x) => x !== e),
        })),
    });

  const drawerTalent = drawerIndex !== null ? (filtered[drawerIndex] ?? null) : null;
  const colCount =
    3 + // select + talent + actions
    (cols.skills ? 1 : 0) +
    (cols.availability ? 1 : 0) +
    (cols.location ? 1 : 0) +
    (cols.rate ? 1 : 0) +
    (cols.consent ? 1 : 0) +
    (cols.owner ? 1 : 0);

  return (
    <section className={drawerTalent !== null ? 'rc-talent rc-talent--drawer' : 'rc-talent'}>
      <div className="rc-viewhead">
        <div>
          <h1 className="rc-h1">Talent</h1>
          <p className="rc-sub">
            <Icons.IconShield className="rc-sub__icon" aria-hidden="true" />
            Your consented working set — {items.length} talent you have permission
            to work. Sourcing is a separate, consent-governed flow.
          </p>
        </div>
        <div className="rc-viewhead__actions">
          {canCreate ? (
            <Link to="/talent/new">
              <Button variant="primary">
                <Icons.IconPlus /> Add talent
              </Button>
            </Link>
          ) : null}
        </div>
      </div>

      {/* scope tabs — page-level (no shared-topbar scope tabs; "My team" is a stub) */}
      <div className="rc-scopetabs" role="group" aria-label="Scope">
        <button
          type="button"
          className={scope === 'mine' ? 'on' : ''}
          aria-pressed={scope === 'mine'}
          onClick={() => setScope('mine')}
        >
          My talent
        </button>
        <button type="button" disabled title="No team tier is modelled yet (carry).">
          My team
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

      {/* views bar */}
      <div className="rc-views" role="group" aria-label="Saved views">
        <span className="rc-views__lbl">Views</span>
        {SAVED_VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            className={`rc-view${activeView === v.key && v.backable ? ' on' : ''}${v.backable ? '' : ' rc-view--stub'}`}
            disabled={!v.backable}
            aria-pressed={activeView === v.key && v.backable}
            title={v.backable ? undefined : v.note}
            onClick={() => pickView(v.key, v.backable)}
          >
            {v.label}
            {!v.backable ? <span className="rc-view__soon">soon</span> : null}
          </button>
        ))}
        <button
          type="button"
          className="rc-view rc-view--stub"
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
          {filtered.length} <small>of {items.length} talent</small>
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
      {truncated ? (
        <p role="status" data-testid="talent-cap-banner" className="rc-sub rc-mt-16">
          Showing the first {DEFAULT_LIST_CAP}. More may exist; cursor pagination
          is on the roadmap.
        </p>
      ) : null}

      <div className="rc-work rc-mt-16">
        <FacetRail
          derived={derived}
          facets={facets}
          loadedCount={items.length}
          onToggleSkill={(s) =>
            setFacets((f) => ({
              ...f,
              skills: f.skills.includes(s)
                ? f.skills.filter((x) => x !== s)
                : [...f.skills, s],
            }))
          }
          onSkillMatch={(m) => setFacets((f) => ({ ...f, skillMatch: m }))}
          onToggleSource={(s) =>
            setFacets((f) => ({
              ...f,
              sources: f.sources.includes(s)
                ? f.sources.filter((x) => x !== s)
                : [...f.sources, s],
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
              {selected.size > 0 ? `${selected.size} selected` : `${filtered.length} talent`}
            </span>
            <div className="rc-rtools__right">
              <details className="rc-colmenu">
                <summary className="rc-mini">
                  <Icons.IconColumns /> Columns
                </summary>
                <div className="rc-colmenu__body">
                  {(
                    [
                      ['skills', 'Skills'],
                      ['availability', 'Availability'],
                      ['location', 'Location'],
                      ['rate', 'Rate'],
                      ['consent', 'Consent'],
                      ['owner', 'Owner'],
                    ] as const
                  ).map(([key, label]) => (
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
              <button
                type="button"
                className="rc-mini"
                onClick={() =>
                  setDensity((d) => (d === 'comfortable' ? 'compact' : 'comfortable'))
                }
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
                        checked={filtered.length > 0 && selected.size >= filtered.length}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? new Set(filtered.map((t) => t.id))
                              : new Set(),
                          )
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
                    {cols.availability ? <th scope="col">Availability</th> : null}
                    {cols.location ? (
                      <th scope="col">
                        <button type="button" className="rc-th-sort" onClick={() => toggleSort('location')}>
                          Location {sortKey === 'location' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                        </button>
                      </th>
                    ) : null}
                    {cols.rate ? (
                      <th scope="col">
                        <button type="button" className="rc-th-sort" onClick={() => toggleSort('rate')}>
                          Rate {sortKey === 'rate' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                        </button>
                      </th>
                    ) : null}
                    {cols.consent ? <th scope="col">Consent</th> : null}
                    {cols.owner ? (
                      <th scope="col">
                        <button type="button" className="rc-th-sort" onClick={() => toggleSort('owner')}>
                          Owner {sortKey === 'owner' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                        </button>
                      </th>
                    ) : null}
                    <th scope="col" aria-label="Row actions" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td className="rc-table__empty" colSpan={colCount}>
                        {items.length === 0
                          ? 'No talent yet in this tenant pool.'
                          : 'No talent matches these filters.'}
                      </td>
                    </tr>
                  ) : (
                    filtered.map((t, i) => (
                      <tr
                        key={t.id}
                        className={`rc-row--clickable${selected.has(t.id) ? ' rc-row--sel' : ''}${drawerIndex === i ? ' rc-row--active' : ''}`}
                        onClick={(e) => {
                          if (e.target instanceof Element && e.target.closest('a,button,input,label'))
                            return;
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
                                  {t.is_hot ? (
                                    <Icons.IconFlame className="rc-ent__flame" />
                                  ) : null}
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
                                <span className="rc-tag rc-tag--more">
                                  +{skillsOf(t).length - 3}
                                </span>
                              ) : null}
                            </span>
                          </td>
                        ) : null}
                        {cols.availability ? (
                          <td>
                            {t.availability_status === null ? (
                              <span className="rc-consent-stub">—</span>
                            ) : (
                              <StatusPill
                                tone={AVAILABILITY_TONE[t.availability_status] ?? 'neutral'}
                                dot
                              >
                                {AVAILABILITY_LABELS[t.availability_status]}
                              </StatusPill>
                            )}
                          </td>
                        ) : null}
                        {cols.location ? <td>{locationOf(t)}</td> : null}
                        {cols.rate ? <td className="num">{statedRate(t)}</td> : null}
                        {cols.consent ? (
                          <td>
                            <span
                              className="rc-consent-stub"
                              title="Per-talent consent state is a carry (N+1, Core-keyed) — wired in Segment 3."
                            >
                              —
                            </span>
                          </td>
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
        total={filtered.length}
        ownerNames={userNames}
        onClose={() => setDrawerIndex(null)}
        onPrev={() => setDrawerIndex((i) => (i === null ? null : Math.max(0, i - 1)))}
        onNext={() =>
          setDrawerIndex((i) =>
            i === null ? null : Math.min(filtered.length - 1, i + 1),
          )
        }
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
          <select
            className="rc-select"
            value={reqId}
            onChange={(e) => setReqId(e.target.value)}
          >
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
