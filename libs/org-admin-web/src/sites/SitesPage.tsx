import { safeErrorMessage, useToast } from '@aramo/fe-foundation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { fetchTenantUsers } from '../users/users-api';
import { OrgModal, OrgPageHeader } from '../ui/OrgPage';

import { messageForSiteError } from './error-messages';
import { createSite, fetchSites } from './sites-api';
import { flattenTree } from './tree';
import type { SiteView } from './types';

// ORG-UX-1 (Directive v1.0 LOCKED §8.5; handoff §6.5) — Sites. The existing D-ORG
// tenant-sites capability (GET/POST /v1/tenant/sites; the server writes the audit
// event). Columns: Site · People · Parent site. The handoff's Code column and field
// are OMITTED — there is no site code in the backend (G5, a documented data gap).
// People = the number of users whose `site_id` is the site (GET /v1/tenant/users).

/** Site · People · Parent site (the handoff's 90px Code track removed, G5). */
export const SITES_COLUMNS = 'minmax(220px,1.6fr) 110px minmax(160px,1fr)';
const SITES_MIN_WIDTH = 520;
const NO_PARENT = '';

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly sites: readonly SiteView[] }
  | { readonly status: 'error'; readonly message: string };

/** Count of users per site id (pure; exported for the spec). */
export function peopleBySite(users: readonly { readonly site_id: string | null }[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const u of users) {
    if (u.site_id === null) continue;
    out.set(u.site_id, (out.get(u.site_id) ?? 0) + 1);
  }
  return out;
}

function PinTile() {
  return (
    <span aria-hidden="true" style={PIN_STYLE}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z" />
      </svg>
    </span>
  );
}

const PIN_STYLE = {
  width: 28,
  height: 28,
  borderRadius: 7,
  background: 'var(--ox-bg)',
  color: 'var(--ox-muted)',
  display: 'grid',
  placeItems: 'center',
  flex: 'none',
} as const;

export function SitesPage() {
  const toast = useToast();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  // null = the roster could not be read (People shows "—", never an invented 0).
  const [people, setPeople] = useState<ReadonlyMap<string, number> | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => {
    fetchSites()
      .then((res) => setLoad({ status: 'ready', sites: res.items }))
      .catch((err: unknown) => setLoad({ status: 'error', message: safeErrorMessage(err, 'We couldn’t load your sites.') }));
    fetchTenantUsers()
      .then((res) => setPeople(peopleBySite(res.items)))
      .catch(() => setPeople(null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const sites = load.status === 'ready' ? load.sites : [];
  const rows = useMemo(() => flattenTree(sites), [sites]);
  const nameById = useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);

  return (
    <>
      <OrgPageHeader
        section="sites"
        actions={
          <button type="button" className="ox-btn ox-btn--primary" onClick={() => setOpen(true)} disabled={load.status !== 'ready'} data-testid="site-add">
            Add site
          </button>
        }
      />
      {load.status === 'error' ? (
        <div className="ox-alert ox-alert--error" role="alert">
          {load.message}
        </div>
      ) : (
        <div className="ox-card ox-table-wrap" aria-busy={load.status === 'loading'}>
          <div className="ox-table" role="table" aria-label="Sites" style={{ minWidth: SITES_MIN_WIDTH }}>
            <div className="ox-tr ox-tr--head" role="row" style={{ gridTemplateColumns: SITES_COLUMNS }}>
              <span role="columnheader">Site</span>
              <span role="columnheader">People</span>
              <span role="columnheader">Parent site</span>
            </div>
            {load.status === 'ready' && rows.length === 0 ? (
              <div className="ox-empty" data-testid="sites-empty">
                No sites yet.
              </div>
            ) : null}
            {rows.map(({ site }) => {
              const parent = site.parent_site_id === null ? null : (nameById.get(site.parent_site_id) ?? null);
              return (
                <div key={site.id} className="ox-tr" role="row" style={{ gridTemplateColumns: SITES_COLUMNS }} data-testid={`site-row-${site.id}`}>
                  <span role="cell" className="ox-row" style={{ gap: 10 }}>
                    <PinTile />
                    <b className="ox-ellipsis" style={{ fontWeight: 600 }}>
                      {site.name}
                    </b>
                    {site.is_active ? null : <span className="ox-pill ox-pill--disabled">Inactive</span>}
                  </span>
                  <span role="cell" data-testid={`site-people-${site.id}`}>
                    {people === null ? '—' : (people.get(site.id) ?? 0)}
                  </span>
                  <span role="cell" className="ox-muted ox-ellipsis">
                    {parent ?? '—'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {open ? (
        <AddSiteModal
          sites={sites}
          onClose={() => setOpen(false)}
          onAdded={(site) => {
            setOpen(false);
            toast.show(`Site “${site.name}” added`);
            refresh();
          }}
        />
      ) : null}
    </>
  );
}

function AddSiteModal({
  sites,
  onClose,
  onAdded,
}: {
  readonly sites: readonly SiteView[];
  readonly onClose: () => void;
  readonly onAdded: (site: SiteView) => void;
}) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState(NO_PARENT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const parents = useMemo(() => sites.filter((s) => s.is_active).sort((a, b) => a.name.localeCompare(b.name)), [sites]);
  const canSubmit = name.trim().length > 0 && !busy;

  const submit = async (ev?: FormEvent) => {
    ev?.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const site = await createSite({ name: name.trim(), parent_site_id: parent === NO_PARENT ? null : parent });
      onAdded(site);
    } catch (err: unknown) {
      setError(messageForSiteError(err));
      setBusy(false);
    }
  };

  return (
    <OrgModal
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Add site"
      subtitle="Offices and delivery centres. Every Aramo app uses the same list."
      testId="site-modal"
      footer={
        <>
          <button type="button" className="ox-btn ox-btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="ox-btn ox-btn--primary" disabled={!canSubmit} onClick={() => void submit()} data-testid="site-add-submit">
            {busy ? 'Adding…' : 'Add site'}
          </button>
        </>
      }
    >
      <form onSubmit={(ev) => void submit(ev)} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {error !== '' ? (
          <div className="ox-alert ox-alert--error" role="alert">
            {error}
          </div>
        ) : null}
        <label className="ox-field">
          <span className="ox-label">Site name</span>
          <input
            className="ox-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Dallas regional office"
            required
            aria-required="true"
            data-testid="site-name"
          />
        </label>
        <label className="ox-field">
          <span className="ox-label">Parent site</span>
          <select className="ox-select" value={parent} onChange={(e) => setParent(e.target.value)} data-testid="site-parent">
            <option value={NO_PARENT}>—</option>
            {parents.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </form>
    </OrgModal>
  );
}
