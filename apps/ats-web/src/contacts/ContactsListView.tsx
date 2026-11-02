import {
  InlineAlert,
  hasScope,
  useSession,
  type Session, Button, Checkbox, Input, Select,
} from '@aramo/fe-foundation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { fetchAssignableUsers, resolveUserNames, type AssignableUser } from '../users/users-api';
import { Avatar, Card, Icons, StatusPill } from '../ui';
import type { ContactView } from '../companies/types';

import { ContactEditDrawer } from './components/ContactEditDrawer';
import { IconRestore, IconTrash } from './components/ContactIcons';
import { DeleteContactDialog } from './components/DeleteContactDialog';
import {
  getContact,
  restoreContact,
  searchContacts,
  updateContact,
} from './contacts-api';
import { listErrorMessage, restoreErrorMessage } from './error-messages';
import {
  EMPTY_FACETS,
  FULL_NAME,
  PREFERENCE_LABELS,
  PREFERENCE_ORDER,
  ROLE_LABELS,
  ROLE_ORDER,
  ROLE_TONES,
  SEGMENTS,
  buildContactQuery,
  isContactable,
  lastContactLabel,
  preferenceLabel,
  preferenceTone,
  relationshipTypeLabel,
  relationshipTypeTone,
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
// the Directory/Cold-call mode, segments, the filters AND the search box
// (CONTACTS-1 F-4: debounced ?q=, contact:search — the box is hidden without
// that scope) are server query params, so search covers the whole visible
// directory and "Load more" pages through the matches. "My contacts" is
// enforced SERVER-SIDE (owner_id from the JWT) — NOT a client filter over an
// all-contacts payload. Every value binds to a real field.
//
// CONTACTS-1 FE-SD-1/FE-SD-2 — contact:delete holders get a delete ICON on each
// row/card (and in the drawer), behind a confirmation, plus a "Deleted" view
// (?deleted=true) whose rows carry a Restore icon. Everyone else sees neither.
//
// Contacts prototype parity — the slide-over edit DRAWER is the ONLY contact
// surface (there is no detail page): clicking a contact (row or card) opens the
// edit drawer, "+ New contact" opens the create drawer (also reachable at
// /contacts/new), and /contacts?edit=<id> deep-links straight to the edit
// drawer for one contact. The filters live in a TOP bar above the table
// (Search + Company ▾ + Role ▾ + Communication ▾ + Owner ▾ + flag pills) — the
// old left facet rail is retired; cold-call mode, segments and bulk-select stay.

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const FLAG_OPTIONS: readonly { value: FacetFlag; label: string }[] = [
  { value: 'hot', label: 'Hot' },
  { value: 'quiet', label: 'Going quiet 14d+' },
  { value: 'former', label: 'Former' },
];
const FLAG_LABELS: Record<FacetFlag, string> = {
  hot: 'Hot',
  quiet: 'Going quiet 14d+',
  former: 'Former',
};

type ViewMode = 'table' | 'cards';

interface ContactsListViewProps {
  readonly sessionOverride?: Session;
  // Contacts prototype parity — /contacts/new resolves to this workspace with
  // the create drawer already open (mirrors /companies/new).
  readonly initialCreate?: boolean;
}

type EditState = {
  readonly mode: 'create' | 'edit';
  readonly contact: ContactView | null;
};

export function ContactsListView({
  sessionOverride,
  initialCreate = false,
}: ContactsListViewProps = {}) {
  const [items, setItems] = useState<readonly ContactView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [facets, setFacets] = useState<ContactFacets | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const [assignableUsers, setAssignableUsers] = useState<readonly AssignableUser[]>([]);

  const [scope, setScope] = useState<ScopeMode>('all');
  const [mode, setMode] = useState<ListMode>('directory');
  const [segment, setSegment] = useState<SegmentKey>('all');
  const [facetState, setFacetState] = useState<FacetState>(EMPTY_FACETS);
  const [ownerFilter, setOwnerFilter] = useState<string>('');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [vmode, setVmode] = useState<ViewMode>('table');
  const [pendingDelete, setPendingDelete] = useState<ContactView | null>(null);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [editState, setEditState] = useState<EditState | null>(
    initialCreate ? { mode: 'create', contact: null } : null,
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Deep-link params — create context (?company_id=<id>, pre-selects the
  // company in the create drawer) + edit deep-link (?edit=<id>, opens the edit
  // drawer for one contact; the company-detail "open this contact" affordance).
  const [searchParams] = useSearchParams();
  const createCompanyId = searchParams.get('company_id') ?? undefined;
  const editId = searchParams.get('edit');

  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const myId = session?.sub ?? null;
  const canCreate =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'contact:create');
  const canAssign =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'contact:edit');
  // CONTACTS-1 — delete + restore + the Deleted view share contact:delete;
  // the server search (?q=) needs contact:search.
  const canDelete =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'contact:delete');
  const canSearch =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'contact:search');
  const isDeletedView = segment === 'deleted';

  // Search text → debounced server ?q= (one request per pause, not per key).
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  // §5 D4c — owner-name resolution → the directory (all users incl. departed).
  useEffect(() => {
    let cancelled = false;
    void resolveUserNames().then((names) => {
      if (!cancelled) setUserNames(names);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Owner-filter options — the shared assignable-users picker source.
  useEffect(() => {
    let cancelled = false;
    void fetchAssignableUsers().then((users) => {
      if (!cancelled) setAssignableUsers(users);
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
        ownerId: ownerFilter,
        q: canSearch ? debouncedQuery : '',
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
        // The segment badges + headline describe the LIVE directory; the
        // Deleted view keeps the last live facets rather than its own.
        if (segment !== 'deleted') setFacets(res.facets ?? null);
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
    [scope, segment, mode, facetState, ownerFilter, canSearch, debouncedQuery],
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

  // ?edit=<id> deep-link — open the edit drawer for that contact. Prefer the
  // loaded page; otherwise fetch it (getContact). Guarded so it fires once per
  // id (an invisible/404 contact silently opens no drawer).
  const handledEdit = useRef<string | null>(null);
  useEffect(() => {
    if (editId === null || editId === '') return;
    if (handledEdit.current === editId) return;
    handledEdit.current = editId;
    const existing = items.find((c) => c.id === editId);
    if (existing !== undefined) {
      setEditState({ mode: 'edit', contact: existing });
      return;
    }
    let cancelled = false;
    void getContact(editId)
      .then((c) => {
        if (!cancelled) setEditState({ mode: 'edit', contact: c });
      })
      .catch(() => {
        /* invisible / 404 → no drawer */
      });
    return () => {
      cancelled = true;
    };
  }, [editId, items]);

  // Every filter (search included) is server-side — the loaded pages ARE the
  // result set.
  const visible = items;

  // company_id → name, from the loaded page (for the filter labels).
  const companyNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of items)
      if (c.company_name !== null) m[c.company_id] = c.company_name;
    return m;
  }, [items]);

  // Single-select set for a top-bar dropdown ('' clears the dimension).
  const setStr = (key: 'role' | 'preference' | 'company', value: string) =>
    setFacetState((f) => ({ ...f, [key]: value === '' ? [] : [value] }));
  const strValue = (key: 'role' | 'preference' | 'company'): string =>
    facetState[key][0] ?? '';
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
    setOwnerFilter('');
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

  const ownerName = (c: ContactView): string =>
    c.owner_id ? (userNames[c.owner_id] ?? '—') : '—';
  const ownerFilterLabel = (id: string): string =>
    id === myId ? 'Me' : (userNames[id] ?? 'Owner');

  // ── active filter chips ──
  const chips: { k: string; label: string; clear: () => void }[] = [];
  if (scope === 'mine')
    chips.push({ k: 'Scope', label: 'My contacts', clear: () => setScope('all') });
  if (ownerFilter !== '')
    chips.push({
      k: 'Owner',
      label: ownerFilterLabel(ownerFilter),
      clear: () => setOwnerFilter(''),
    });
  if (segment !== 'all')
    chips.push({
      k: 'View',
      label:
        segment === 'deleted'
          ? 'Deleted'
          : (SEGMENTS.find((s) => s.key === segment)?.label ?? segment),
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
  const isCold = mode === 'cold';

  // Contacts prototype headline — "{n} contacts across {m} companies · {p}
  // primary". n from the server total; m from the server company facet (the
  // distinct-company base count); p from the server primary facet (CONTACTS-1
  // F-4), falling back to the loaded page only on a response without it.
  const companyCount =
    facets?.company.length ?? new Set(items.map((c) => c.company_id)).size;
  const primaryCount =
    facets?.primary ?? items.filter((c) => c.is_primary).length;
  const headline = isDeletedView
    ? `${total} deleted ${total === 1 ? 'contact' : 'contacts'} — restore one to return it to the directory`
    : `${total} ${total === 1 ? 'contact' : 'contacts'} across ${companyCount} ${companyCount === 1 ? 'company' : 'companies'} · ${primaryCount} primary`;

  // ── drawer wiring (row/card click → edit; "+ New contact" → create) ──
  const editingId = editState?.contact?.id ?? null;
  const openEdit = (c: ContactView) => setEditState({ mode: 'edit', contact: c });
  const openCreate = () => setEditState({ mode: 'create', contact: null });
  const onSaved = () => {
    setEditState(null);
    void fetchPage(null, false);
  };
  // CONTACTS-1 — after a delete (row, card or drawer) the contact leaves the
  // live list; refetch so the totals + facets follow.
  const onDeleted = (c: ContactView) => {
    setPendingDelete(null);
    if (editState?.contact?.id === c.id) setEditState(null);
    setSelected(new Set());
    setNotice(`Deleted ${FULL_NAME(c)}.`);
    void fetchPage(null, false);
  };
  const restore = async (c: ContactView) => {
    setBusy(true);
    setNotice(null);
    try {
      await restoreContact(c.id);
      setNotice(`Restored ${FULL_NAME(c)}.`);
      void fetchPage(null, false);
    } catch (err) {
      setNotice(restoreErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Owner-filter select options — Me / each assignable user.
  const ownerOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    if (myId !== null) opts.push({ value: myId, label: 'Me' });
    for (const u of assignableUsers) {
      if (u.user_id === myId) continue;
      opts.push({ value: u.user_id, label: u.display_name ?? u.user_id });
    }
    return opts;
  }, [assignableUsers, myId]);

  // Company-filter options — the distinct companies in the server base set.
  const companyOptions = useMemo(
    () =>
      (facets?.company ?? []).map((b) => ({
        value: b.value,
        label: companyNames[b.value] ?? 'Company',
      })),
    [facets, companyNames],
  );

  return (
    <section
      className={editState !== null ? 'rc-talent rc-talent--drawer' : 'rc-talent'}
    >
      <div className="rc-viewhead">
        <div>
          <div className="rc-titlerow">
            <h1 className="rc-h1">Contacts</h1>
            <div className="rc-scopetabs" role="group" aria-label="Scope">
              <Button unstyled
                type="button"
                className={scope === 'mine' ? 'on' : ''}
                aria-pressed={scope === 'mine'}
                onClick={() => setScope('mine')}
              >
                My contacts
              </Button>
              <Button unstyled
                type="button"
                className={scope === 'all' ? 'on' : ''}
                aria-pressed={scope === 'all'}
                onClick={() => setScope('all')}
              >
                All
              </Button>
            </div>
          </div>
          {!isCold ? <p className="rc-sub rc-sub--count">{headline}</p> : null}
          <p className="rc-sub">
            <Icons.IconShield className="rc-sub__icon" aria-hidden="true" />
            {isCold
              ? 'Cold-call queue — contactable people with a work number, ordered by who you haven’t spoken to longest. Do-not-contact records are excluded.'
              : 'Your client contacts — hiring managers and decision-makers across your visible accounts.'}
          </p>
        </div>
        <div className="rc-viewhead__actions">
          <div className="rc-scopetabs" role="group" aria-label="Mode">
            <Button unstyled
              type="button"
              className={mode === 'directory' ? 'on' : ''}
              aria-pressed={mode === 'directory'}
              onClick={() => setMode('directory')}
            >
              Directory
            </Button>
            <Button unstyled
              type="button"
              className={mode === 'cold' ? 'on' : ''}
              aria-pressed={mode === 'cold'}
              onClick={() => setMode('cold')}
            >
              Cold-call list
            </Button>
          </div>
          {!isCold ? (
            <div className="rc-scopetabs" role="group" aria-label="View mode">
              <Button unstyled
                type="button"
                className={vmode === 'table' ? 'on' : ''}
                aria-pressed={vmode === 'table'}
                onClick={() => setVmode('table')}
              >
                Table
              </Button>
              <Button unstyled
                type="button"
                className={vmode === 'cards' ? 'on' : ''}
                aria-pressed={vmode === 'cards'}
                onClick={() => setVmode('cards')}
              >
                Cards
              </Button>
            </div>
          ) : null}
          {canCreate ? (
            <Button unstyled
              type="button"
              className="rc-hbtn rc-hbtn--primary"
              onClick={openCreate}
              data-testid="contact-new"
            >
              <Icons.IconUserPlus /> New contact
            </Button>
          ) : null}
        </div>
      </div>

      {!isCold ? (
        <div className="rc-views" role="group" aria-label="Views">
          <span className="rc-views__lbl">Views</span>
          {SEGMENTS.map((s) => {
            const count = segmentCountFrom(facets, total, s.key);
            return (
              <Button unstyled
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
              </Button>
            );
          })}
          {canDelete ? (
            <Button unstyled
              type="button"
              className={`rc-view${isDeletedView ? ' on' : ''}`}
              aria-pressed={isDeletedView}
              onClick={() => setSegment('deleted')}
            >
              Deleted
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Server search (?q=) — rendered only for contact:search holders
          (permission-driven: hidden, never a disabled control). */}
      {canSearch ? (
        <div className="rc-tokenbox">
          <Icons.IconSearch className="rc-tokenbox__icon" aria-hidden="true" />
          <Input unstyled
            className="rc-tokenbox__input"
            type="search"
            placeholder="Search contacts by name, title, email or company"
            aria-label="Search contacts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}

      {/* Contacts prototype parity — the TOP filter bar (replaces the left facet
          rail): Company ▾ · Role ▾ · Communication ▾ · Owner ▾ + flag pills. */}
      {!isCold ? (
        <div className="rc-views" role="group" aria-label="Filters">
          <span className="rc-views__lbl">Filters</span>
          <Select unstyled
            className="rc-view"
            aria-label="Filter by company"
            value={strValue('company')}
            onChange={(e) => setStr('company', e.target.value)}
          >
            <option value="">Company: all</option>
            {companyOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
          <Select unstyled
            className="rc-view"
            aria-label="Filter by role"
            value={strValue('role')}
            onChange={(e) => setStr('role', e.target.value)}
          >
            <option value="">Role: all</option>
            {ROLE_ORDER.map((r) => (
              <option key={r} value={r}>{ROLE_LABELS[r] ?? r}</option>
            ))}
          </Select>
          <Select unstyled
            className="rc-view"
            aria-label="Filter by communication"
            value={strValue('preference')}
            onChange={(e) => setStr('preference', e.target.value)}
          >
            <option value="">Communication: all</option>
            {PREFERENCE_ORDER.map((p) => (
              <option key={p} value={p}>{PREFERENCE_LABELS[p] ?? p}</option>
            ))}
          </Select>
          <Select unstyled
            className="rc-view"
            aria-label="Filter by owner"
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
          >
            <option value="">Owner: anyone</option>
            {ownerOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
          {FLAG_OPTIONS.map((f) => {
            const on = facetState.flags.includes(f.value);
            return (
              <Button unstyled
                key={f.value}
                type="button"
                className={`rc-view${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => toggleFlag(f.value)}
              >
                {f.label}
              </Button>
            );
          })}
        </div>
      ) : null}

      <div className="rc-activebar">
        <span className="rc-activebar__count num">
          {visible.length}
          <small> {isCold ? 'to call' : `of ${total} contacts`}</small>
        </span>
        {chips.length > 0 ? <span className="rc-activebar__sep" /> : null}
        {chips.map((c, i) => (
          <span key={`${c.k}-${c.label}-${i}`} className="rc-fchip">
            <span className="rc-fchip__k">{c.k}</span> {c.label}
            <Button
              type="button"
              aria-label={`Remove ${c.k} ${c.label}`}
              onClick={c.clear}
            >
              <Icons.IconX />
            </Button>
          </span>
        ))}
        {chips.length > 0 ? (
          <Button unstyled type="button" className="rc-activebar__clear" onClick={resetAll}>
            Clear all
          </Button>
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
                : `${visible.length} contacts`}
            </span>
          </div>

          {loading ? (
            <p className="rc-empty">Loading contacts…</p>
          ) : visible.length === 0 ? (
            <p className="rc-empty">
              {isCold
                ? 'No one to call — every contactable person with a number has been reached recently.'
                : isDeletedView
                  ? 'No deleted contacts.'
                  : hasActiveQuery
                  ? 'No contacts match these filters.'
                  : 'No contacts visible to you yet.'}
            </p>
          ) : !isCold && !isDeletedView && vmode === 'cards' ? (
            <div className="rc-cocards">
              {visible.map((c) => (
                <ContactCard
                  key={c.id}
                  contact={c}
                  onOpen={() => openEdit(c)}
                  onDelete={canDelete ? () => setPendingDelete(c) : undefined}
                />
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
                      <th scope="col" style={{ width: 34 }}>
                        <Checkbox
                         
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
                      <th scope="col">Email</th>
                      <th scope="col">Phone</th>
                      <th scope="col">Owner</th>
                      <th scope="col">Last contact</th>
                      {canDelete ? <th scope="col" aria-label="Actions" /> : null}
                    </tr>
                  )}
                </thead>
                <tbody>
                  {visible.map((c) => {
                    if (isCold) {
                      return (
                        <tr
                          key={c.id}
                          className="rc-row--clickable"
                          onClick={(e) => {
                            if (
                              e.target instanceof Element &&
                              e.target.closest('a,button,input,label')
                            )
                              return;
                            openEdit(c);
                          }}
                        >
                          <td>{c.company_name ?? '—'}</td>
                          <td>
                            <span className="rc-ent">
                              <Avatar name={FULL_NAME(c)} size="sm" />
                              <Button unstyled
                                type="button"
                                className="rc-link-strong"
                                onClick={() => openEdit(c)}
                              >
                                {FULL_NAME(c)}
                              </Button>
                            </span>
                          </td>
                          <td>{c.title ?? '—'}</td>
                          <td className="mono">{c.phone_work ?? '—'}</td>
                          <td className="lastcell">{lastContactLabel(c)}</td>
                        </tr>
                      );
                    }
                    // A deleted contact accepts no edits (PATCH → 404), so the
                    // Deleted view's rows do not open the drawer.
                    return (
                      <tr
                        key={c.id}
                        className={`${isDeletedView ? '' : 'rc-row--clickable'}${selected.has(c.id) ? ' rc-row--sel' : ''}${editingId === c.id ? ' rc-row--active' : ''}`}
                        onClick={(e) => {
                          if (isDeletedView) return;
                          if (
                            e.target instanceof Element &&
                            e.target.closest('a,button,input,label')
                          )
                            return;
                          openEdit(c);
                        }}
                      >
                        <td>
                          <Checkbox
                           
                            aria-label={`Select ${FULL_NAME(c)}`}
                            checked={selected.has(c.id)}
                            onChange={() => toggleSel(c.id)}
                          />
                        </td>
                        <td>
                          <span className="rc-ent">
                            <Avatar name={FULL_NAME(c)} size="sm" />
                            <span>
                              <span className="rc-ent__nm">
                                {isDeletedView ? (
                                  <span className="rc-link-strong">{FULL_NAME(c)}</span>
                                ) : (
                                  <Button unstyled
                                    type="button"
                                    className="rc-link-strong"
                                    onClick={() => openEdit(c)}
                                  >
                                    {FULL_NAME(c)}
                                  </Button>
                                )}
                                {c.is_primary ? (
                                  <StatusPill tone="brand">Primary</StatusPill>
                                ) : null}
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
                        </td>
                        <td>
                          <span className="rc-relpills">
                            <span className="rc-relpills__co">
                              {c.company_name ?? '—'}
                            </span>
                            {(c.relationship_types ?? []).map((t) => (
                              <StatusPill key={t} tone={relationshipTypeTone(t)} dot>
                                {relationshipTypeLabel(t)}
                              </StatusPill>
                            ))}
                          </span>
                        </td>
                        <td>{c.email1 ?? '—'}</td>
                        <td className="mono">{c.phone_work ?? c.phone_cell ?? '—'}</td>
                        <td>{ownerName(c)}</td>
                        <td className="lastcell">
                          {lastContactLabel(c)}
                          {c.preference === 'do_not_contact' ? (
                            <StatusPill tone="danger">Do not contact</StatusPill>
                          ) : null}
                        </td>
                        {canDelete ? (
                          <td>
                            {isDeletedView ? (
                              <Button unstyled
                                type="button"
                                className="rc-iconbtn"
                                aria-label={`Restore ${FULL_NAME(c)}`}
                                title="Restore contact"
                                disabled={busy}
                                onClick={() => void restore(c)}
                              >
                                <IconRestore />
                              </Button>
                            ) : (
                              <Button unstyled
                                type="button"
                                className="rc-iconbtn"
                                aria-label={`Delete ${FULL_NAME(c)}`}
                                title="Delete contact"
                                onClick={() => setPendingDelete(c)}
                              >
                                <IconTrash />
                              </Button>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {nextCursor !== null ? (
                <div className="rc-loadmore">
                  <Button unstyled
                    type="button"
                    className="tc-button tc-button--ghost"
                    onClick={loadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore ? 'Loading…' : 'Load more contacts'}
                  </Button>
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

      {!isCold && !isDeletedView && selected.size > 0 ? (
        <div className="rc-bulkbar" role="region" aria-label="Bulk actions">
          <span className="rc-bulkbar__n num">
            {selected.size} <small>selected</small>
          </span>
          <span className="rc-bulkbar__sep" />
          {/* T10-B3/F-012 — permission-driven: HIDE when the actor lacks the
              write scope (never a disabled control naming the scope). Disabled
              only while a submit is in flight. */}
          {canAssign ? (
            <Button
              type="button"
              onClick={assignToMe}
              disabled={busy}
              title="Set you as owner on the selected contacts"
            >
              <Icons.IconUserPlus />
              Assign to me
            </Button>
          ) : null}
          {/* Honest carries — disabled with reason (saved-list + owner-picker). */}
          <Button
            type="button"
            disabled
            title="Saved lists aren’t granted to recruiters yet (saved-list scope carry)."
          >
            <Icons.IconList />
            Add to list
          </Button>
          <span className="rc-bulkbar__sep" />
          <span
            className="rc-bulkbar__ex"
            title="Bulk contact export isn’t available in this prototype (consent moat)."
          >
            <Icons.IconShield />
            Export off
          </span>
          <Button unstyled
            type="button"
            className="rc-bulkbar__x"
            aria-label="Clear selection"
            onClick={() => setSelected(new Set())}
          >
            <Icons.IconX />
          </Button>
        </div>
      ) : null}

      {editState !== null ? (
        <ContactEditDrawer
          mode={editState.mode}
          contact={editState.contact}
          initialCompanyId={editState.mode === 'create' ? createCompanyId : undefined}
          onClose={() => setEditState(null)}
          onSaved={onSaved}
          canDelete={canDelete}
          onDeleted={onDeleted}
        />
      ) : null}

      {pendingDelete !== null ? (
        <DeleteContactDialog
          contactId={pendingDelete.id}
          contactName={FULL_NAME(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
          onDeleted={() => onDeleted(pendingDelete)}
        />
      ) : null}
    </section>
  );
}

// ── Card (Cards view mode) — same data as the row; click opens the drawer. ──
// CONTACTS-1 FE-SD-1 — the delete icon is a SIBLING of the card button (a
// button may not contain another), positioned in the card's corner.
function ContactCard({
  contact,
  onOpen,
  onDelete,
}: {
  readonly contact: ContactView;
  readonly onOpen: () => void;
  readonly onDelete?: () => void;
}) {
  const role = roleLabel(contact.relationship_role);
  return (
    <div className="rc-cocard-wrap">
      <Button unstyled type="button" className="rc-cocard" onClick={onOpen}>
        <div className="rc-cocard__top">
          <Avatar name={FULL_NAME(contact)} size="md" />
          <div className="rc-cocard__id">
            <span className="rc-ent__nm">
              {FULL_NAME(contact)}
              {contact.is_primary ? <StatusPill tone="brand">Primary</StatusPill> : null}
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
          {(contact.relationship_types ?? []).map((t) => (
            <StatusPill key={t} tone={relationshipTypeTone(t)} dot>
              {relationshipTypeLabel(t)}
            </StatusPill>
          ))}
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
      </Button>
      {onDelete !== undefined ? (
        <Button unstyled
          type="button"
          className="rc-iconbtn"
          aria-label={`Delete ${FULL_NAME(contact)}`}
          title="Delete contact"
          onClick={onDelete}
        >
          <IconTrash />
        </Button>
      ) : null}
    </div>
  );
}
