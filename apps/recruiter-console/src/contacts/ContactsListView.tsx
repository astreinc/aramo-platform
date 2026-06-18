import {
  InlineAlert,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { probeTenantUsers } from '../task/task-api';
import { Avatar, Card, Icons, StatusPill } from '../ui';
import type { ContactView } from '../companies/types';

import { ContactFacetRail } from './components/ContactFacetRail';
import { searchContacts, updateContact } from './contacts-api';
import { listErrorMessage } from './error-messages';
import {
  EMPTY_FACETS,
  FULL_NAME,
  PREFERENCE_LABELS,
  ROLE_LABELS,
  ROLE_TONES,
  SEGMENTS,
  buildContactQuery,
  isContactable,
  lastContactLabel,
  matchesText,
  preferenceLabel,
  preferenceTone,
  roleLabel,
  segmentCountFrom,
  type ContactFacets,
  type FacetFlag,
  type FacetState,
  type ListMode,
  type ScopeMode,
  type SegmentKey,
} from './contact-workspace';

// Contacts directory — SERVER-PAGED (?paged=true) faceted list. Scope (My/All),
// the Directory/Cold-call mode, segments, and the facet rail are server query
// params; the in-list text box filters the LOADED page client-side (never sends
// ?q=). "My contacts" is enforced SERVER-SIDE (owner_id from the JWT) — NOT a
// client filter over an all-contacts payload. Every value binds to a real field.

const PAGE_SIZE = 50;
const FLAG_LABELS: Record<FacetFlag, string> = {
  hot: 'Hot',
  quiet: 'Going quiet 14d+',
  former: 'Former',
};

type ViewMode = 'table' | 'cards';

interface ContactsListViewProps {
  readonly sessionOverride?: Session;
}

export function ContactsListView({ sessionOverride }: ContactsListViewProps = {}) {
  const [items, setItems] = useState<readonly ContactView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [facets, setFacets] = useState<ContactFacets | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userNames, setUserNames] = useState<Record<string, string>>({});

  const [scope, setScope] = useState<ScopeMode>('all');
  const [mode, setMode] = useState<ListMode>('directory');
  const [segment, setSegment] = useState<SegmentKey>('all');
  const [facetState, setFacetState] = useState<FacetState>(EMPTY_FACETS);
  const [query, setQuery] = useState('');
  const [vmode, setVmode] = useState<ViewMode>('table');

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const myId = session?.sub ?? null;
  const canAssign =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'contact:edit');

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

  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean) => {
      const params = buildContactQuery({
        scope,
        segment,
        mode,
        facets: facetState,
        cursor,
        pageSize: PAGE_SIZE,
      });
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const res = await searchContacts(params);
        const pageItems = res.items ?? [];
        setItems((prev) => (append ? [...prev, ...pageItems] : [...pageItems]));
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
    [scope, segment, mode, facetState],
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

  // The text box filters the LOADED page (client-side; no ?q=).
  const visible = useMemo(
    () => items.filter((c) => matchesText(c, query)),
    [items, query],
  );

  // company_id → name, from the loaded page (for the facet rail labels).
  const companyNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of items)
      if (c.company_name !== null) m[c.company_id] = c.company_name;
    return m;
  }, [items]);

  const toggleStr = (key: 'role' | 'preference' | 'company', value: string) =>
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

  const loadMore = () => {
    if (nextCursor !== null) void fetchPage(nextCursor, true);
  };

  const assignToMe = async () => {
    if (myId === null || selected.size === 0) return;
    const ids = visible.filter((c) => selected.has(c.id)).map((c) => c.id);
    setBusy(true);
    setNotice(null);
    try {
      await Promise.all(ids.map((id) => updateContact(id, { owner_id: myId })));
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
    chips.push({ k: 'Scope', label: 'My contacts', clear: () => setScope('all') });
  if (segment !== 'all')
    chips.push({
      k: 'View',
      label: SEGMENTS.find((s) => s.key === segment)?.label ?? segment,
      clear: () => setSegment('all'),
    });
  for (const r of facetState.role)
    chips.push({
      k: 'Role',
      label: ROLE_LABELS[r] ?? r,
      clear: () => toggleStr('role', r),
    });
  for (const p of facetState.preference)
    chips.push({
      k: 'Communication',
      label: PREFERENCE_LABELS[p] ?? p,
      clear: () => toggleStr('preference', p),
    });
  for (const co of facetState.company)
    chips.push({
      k: 'Company',
      label: companyNames[co] ?? 'Company',
      clear: () => toggleStr('company', co),
    });
  for (const f of facetState.flags)
    chips.push({ k: 'Flag', label: FLAG_LABELS[f], clear: () => toggleFlag(f) });

  const hasActiveQuery = chips.length > 0 || query.trim() !== '';
  const ownerName = (c: ContactView): string =>
    c.owner_id ? (userNames[c.owner_id] ?? '—') : '—';
  const isCold = mode === 'cold';

  return (
    <section className="rc-talent">
      <div className="rc-viewhead">
        <div>
          <div className="rc-titlerow">
            <h1 className="rc-h1">Contacts</h1>
            <div className="rc-scopetabs" role="group" aria-label="Scope">
              <button
                type="button"
                className={scope === 'mine' ? 'on' : ''}
                aria-pressed={scope === 'mine'}
                onClick={() => setScope('mine')}
              >
                My contacts
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
            {isCold
              ? 'Cold-call queue — contactable people with a work number, ordered by who you haven’t spoken to longest. Do-not-contact records are excluded.'
              : 'Your client contacts — hiring managers and decision-makers across your visible accounts.'}
          </p>
        </div>
        <div className="rc-viewhead__actions">
          <div className="rc-scopetabs" role="group" aria-label="Mode">
            <button
              type="button"
              className={mode === 'directory' ? 'on' : ''}
              aria-pressed={mode === 'directory'}
              onClick={() => setMode('directory')}
            >
              Directory
            </button>
            <button
              type="button"
              className={mode === 'cold' ? 'on' : ''}
              aria-pressed={mode === 'cold'}
              onClick={() => setMode('cold')}
            >
              Cold-call list
            </button>
          </div>
          {!isCold ? (
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
          ) : null}
        </div>
      </div>

      {!isCold ? (
        <div className="rc-views" role="group" aria-label="Views">
          <span className="rc-views__lbl">Views</span>
          {SEGMENTS.map((s) => {
            const count = segmentCountFrom(facets, total, s.key);
            return (
              <button
                key={s.key}
                type="button"
                className={`rc-view${segment === s.key ? ' on' : ''}`}
                aria-pressed={segment === s.key}
                onClick={() => setSegment(s.key)}
              >
                {s.label}
                {count !== null ? (
                  <span className="rc-view__ct num">{count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="rc-tokenbox">
        <Icons.IconSearch className="rc-tokenbox__icon" aria-hidden="true" />
        <input
          className="rc-tokenbox__input"
          type="search"
          placeholder="Filter loaded contacts by name, title, email or company"
          aria-label="Filter contacts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="rc-activebar">
        <span className="rc-activebar__count num">
          {visible.length}
          <small> {isCold ? 'to call' : `of ${total} contacts`}</small>
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

      <div className="rc-work rc-mt-16">
        {!isCold ? (
          <ContactFacetRail
            facets={facets}
            selected={facetState}
            companyNames={companyNames}
            onToggleRole={(v) => toggleStr('role', v)}
            onTogglePreference={(v) => toggleStr('preference', v)}
            onToggleCompany={(v) => toggleStr('company', v)}
            onToggleFlag={(v) => toggleFlag(v)}
            onReset={resetAll}
          />
        ) : null}

        <Card flush>
          <div className="rc-rtools">
            <span className="rc-rtools__note">
              {selected.size > 0
                ? `${selected.size} selected`
                : `${visible.length} contacts`}
            </span>
          </div>

          {loading ? (
            <p className="rc-empty">Loading contacts…</p>
          ) : visible.length === 0 ? (
            <p className="rc-empty">
              {isCold
                ? 'No one to call — every contactable person with a number has been reached recently.'
                : hasActiveQuery
                  ? 'No contacts match these filters.'
                  : 'No contacts visible to you yet.'}
            </p>
          ) : !isCold && vmode === 'cards' ? (
            <div className="rc-cocards">
              {visible.map((c) => (
                <ContactCard key={c.id} contact={c} />
              ))}
            </div>
          ) : (
            <div className="rc-tablewrap">
              <table className="rc-table">
                <thead>
                  {isCold ? (
                    <tr>
                      <th scope="col">Company</th>
                      <th scope="col">Contact</th>
                      <th scope="col">Title</th>
                      <th scope="col">Work phone</th>
                      <th scope="col">Last contact</th>
                    </tr>
                  ) : (
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
                      <th scope="col">Contact</th>
                      <th scope="col">Company</th>
                      <th scope="col">Role</th>
                      <th scope="col">Owner</th>
                      <th scope="col">Last contact</th>
                    </tr>
                  )}
                </thead>
                <tbody>
                  {visible.map((c) => {
                    const role = roleLabel(c.relationship_role);
                    if (isCold) {
                      return (
                        <tr key={c.id} className="rc-row--clickable">
                          <td>{c.company_name ?? '—'}</td>
                          <td>
                            <Link
                              to={`/contacts/${c.id}`}
                              className="rc-link-strong"
                            >
                              <span className="rc-ent">
                                <Avatar name={FULL_NAME(c)} size="sm" />
                                <span className="rc-ent__nm">{FULL_NAME(c)}</span>
                              </span>
                            </Link>
                          </td>
                          <td>{c.title ?? '—'}</td>
                          <td className="mono">{c.phone_work ?? '—'}</td>
                          <td className="lastcell">{lastContactLabel(c)}</td>
                        </tr>
                      );
                    }
                    return (
                      <tr
                        key={c.id}
                        className={`rc-row--clickable${selected.has(c.id) ? ' rc-row--sel' : ''}`}
                      >
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${FULL_NAME(c)}`}
                            checked={selected.has(c.id)}
                            onChange={() => toggleSel(c.id)}
                          />
                        </td>
                        <td>
                          <Link
                            to={`/contacts/${c.id}`}
                            className="rc-link-strong"
                          >
                            <span className="rc-ent">
                              <Avatar name={FULL_NAME(c)} size="sm" />
                              <span>
                                <span className="rc-ent__nm">
                                  {FULL_NAME(c)}
                                  {c.is_hot ? (
                                    <Icons.IconFlame className="rc-ent__flame" />
                                  ) : null}
                                </span>
                                <span className="rc-ent__rl">
                                  {[c.title, c.left_company ? 'former' : null]
                                    .filter((s) => s !== null && s !== '')
                                    .join(' · ') || '—'}
                                </span>
                              </span>
                            </span>
                          </Link>
                        </td>
                        <td>{c.company_name ?? '—'}</td>
                        <td>
                          {role !== null ? (
                            <StatusPill
                              tone={ROLE_TONES[c.relationship_role ?? ''] ?? 'neutral'}
                              dot
                            >
                              {role}
                            </StatusPill>
                          ) : (
                            <span className="rc-consent-stub">—</span>
                          )}
                        </td>
                        <td>{ownerName(c)}</td>
                        <td className="lastcell">
                          {lastContactLabel(c)}
                          {c.preference === 'do_not_contact' ? (
                            <StatusPill tone="danger">Do not contact</StatusPill>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {nextCursor !== null && query.trim() === '' ? (
                <div className="rc-loadmore">
                  <button
                    type="button"
                    className="tc-button tc-button--ghost"
                    onClick={loadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore ? 'Loading…' : 'Load more contacts'}
                  </button>
                </div>
              ) : null}
            </div>
          )}

          <p className="rc-footnote">
            Contacts shown are the people at clients visible to you through
            assignments, reports, or pod-client teams.
          </p>
        </Card>
      </div>

      {!isCold && selected.size > 0 ? (
        <div className="rc-bulkbar" role="region" aria-label="Bulk actions">
          <span className="rc-bulkbar__n num">
            {selected.size} <small>selected</small>
          </span>
          <span className="rc-bulkbar__sep" />
          <button
            type="button"
            onClick={assignToMe}
            disabled={busy || !canAssign}
            title={
              canAssign
                ? 'Set you as owner on the selected contacts'
                : 'Needs contact:edit'
            }
          >
            <Icons.IconUserPlus />
            Assign to me
          </button>
          {/* Honest carries — disabled with reason (saved-list + owner-picker). */}
          <button
            type="button"
            disabled
            title="Saved lists aren’t granted to recruiters yet (saved-list scope carry)."
          >
            <Icons.IconList />
            Add to list
          </button>
          <span className="rc-bulkbar__sep" />
          <span
            className="rc-bulkbar__ex"
            title="Bulk contact export isn’t available in this prototype (consent moat)."
          >
            <Icons.IconShield />
            Export off
          </span>
          <button
            type="button"
            className="rc-bulkbar__x"
            aria-label="Clear selection"
            onClick={() => setSelected(new Set())}
          >
            <Icons.IconX />
          </button>
        </div>
      ) : null}
    </section>
  );
}

// ── Card (Cards view mode) — same data as the row, no fabricated stats. ──
function ContactCard({ contact }: { readonly contact: ContactView }) {
  const role = roleLabel(contact.relationship_role);
  return (
    <Link to={`/contacts/${contact.id}`} className="rc-cocard">
      <div className="rc-cocard__top">
        <Avatar name={FULL_NAME(contact)} size="md" />
        <div className="rc-cocard__id">
          <span className="rc-ent__nm">
            {FULL_NAME(contact)}
            {contact.is_hot ? <Icons.IconFlame className="rc-ent__flame" /> : null}
          </span>
          <span className="rc-ent__rl">{contact.title ?? '—'}</span>
        </div>
      </div>
      <div className="rc-cocard__meta">
        {role !== null ? (
          <StatusPill
            tone={ROLE_TONES[contact.relationship_role ?? ''] ?? 'neutral'}
            dot
          >
            {role}
          </StatusPill>
        ) : null}
        {!isContactable(contact) ? (
          <StatusPill tone="danger">Do not contact</StatusPill>
        ) : (
          <StatusPill tone={preferenceTone(contact.preference)}>
            {preferenceLabel(contact.preference)}
          </StatusPill>
        )}
      </div>
      <div className="rc-cocard__foot">
        <span className="rc-cocard__stat">
          <small>Company</small>
          {contact.company_name ?? '—'}
        </span>
        <span className="rc-cocard__stat">
          <small>Last contact</small>
          {lastContactLabel(contact)}
        </span>
      </div>
    </Link>
  );
}
