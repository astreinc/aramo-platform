import { fetchMyProducts, useMyProducts, type ProductAvailabilityView, type Session } from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { fetchAuditEvents } from '../audit/audit-api';
import { eventTypeLabel } from '../audit/event-labels';
import type { AuditEventView } from '../audit/types';
import type { DomainVerificationStatus } from '../domain/domain-api';
import { OrgPageHeader } from '../ui/OrgPage';
import { InviteUserModal } from '../users/InviteUserModal';
import { deriveDisplayedStatus } from '../users/user-status';
import type { TenantUserView } from '../users/types';

import {
  checklistStateOf,
  DEFAULT_SETUP_FETCHERS,
  useOrgSetupData,
  type OrgSetupFetchers,
  type SetupItem,
} from './setup-checklist';

import './overview.css';

// ORG-UX-1 (Directive v1.0 LOCKED §8.9; handoff §6.1) — Overview: 4 summary tiles (People ·
// Apps · Sites · Domain), the setup checklist and the last 4 audit entries. Every number
// is read from an existing endpoint; nothing is invented (a failed read shows "—").
// Admin-only (the route gates on the server's org_access).

const APP_NAMES: Readonly<Record<string, string>> = { ats: 'Aramo ATS', sign: 'Aramo Sign', intelligence: 'Talent Intelligence' };

export const DOMAIN_STATUS_VIEW: Readonly<Record<DomainVerificationStatus, { readonly label: string; readonly color: string }>> = {
  UNVERIFIED: { label: 'Not verified', color: '#946011' },
  PENDING: { label: 'Checking…', color: '#011F8D' },
  VERIFIED: { label: 'Verified', color: '#1F7A4D' },
};

/** People tile counts (pure; exported for the spec). Invited = Invited + Accepted (H9 tone). */
export function peopleCounts(users: readonly TenantUserView[]): { readonly active: number; readonly invited: number; readonly disabled: number } {
  let active = 0;
  let invited = 0;
  let disabled = 0;
  for (const u of users) {
    const s = deriveDisplayedStatus(u);
    if (s === 'ACTIVE') active++;
    else if (s === 'INVITED' || s === 'ACCEPTED') invited++;
    else if (s === 'INACTIVE') disabled++;
  }
  return { active, invited, disabled };
}

/** The subscribed apps (the Organization entry is not an app). */
export function subscribedApps(view: ProductAvailabilityView | null): readonly string[] {
  return (view?.products ?? []).filter((p) => p.key !== 'org' && p.subscribed).map((p) => APP_NAMES[p.key] ?? p.key);
}

/** "Oct 21 09:14" — the Recent changes time column. */
export function shortWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const month = d.toLocaleString('en-US', { month: 'short' });
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${month} ${d.getDate()} ${hh}:${mm}`;
}

type AuditState = { readonly status: 'loading' } | { readonly status: 'ready'; readonly items: readonly AuditEventView[] } | { readonly status: 'error' };

interface OverviewPageProps {
  readonly session?: Session;
  readonly products?: ProductAvailabilityView | null;
  /** Test seams. */
  readonly fetchers?: OrgSetupFetchers;
  readonly fetchAudit?: () => Promise<readonly AuditEventView[]>;
  readonly fetchProducts?: () => Promise<ProductAvailabilityView>;
}

const defaultFetchAudit = async () => (await fetchAuditEvents({ limit: 4 })).items;

export function OverviewPage({ products, fetchers = DEFAULT_SETUP_FETCHERS, fetchAudit = defaultFetchAudit, fetchProducts }: OverviewPageProps) {
  const data = useOrgSetupData(fetchers);
  const checklist = checklistStateOf(data);
  const productsFetch = useMemo(
    () => (products ? () => Promise.resolve(products) : (fetchProducts ?? fetchMyProducts)),
    [products, fetchProducts],
  );
  const productsState = useMyProducts(productsFetch);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [audit, setAudit] = useState<AuditState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchAudit()
      .then((items) => {
        if (!cancelled) setAudit({ status: 'ready', items: items.slice(0, 4) });
      })
      .catch(() => {
        if (!cancelled) setAudit({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchAudit]);

  const src = data.status === 'ready' ? data.sources : null;
  const people = src ? peopleCounts(src.users) : null;
  const apps = productsState.status === 'ready' ? subscribedApps(productsState.view) : null;
  const dom = src ? DOMAIN_STATUS_VIEW[src.domain.status] : null;

  const tiles = [
    { key: 'people', label: 'People', value: people ? String(people.active) : '—', sub: people ? `${people.invited} invited · ${people.disabled} disabled` : '', to: '/org/users' },
    { key: 'apps', label: 'Apps', value: apps ? String(apps.length) : '—', sub: apps ? apps.join(' · ') || 'No apps yet' : '', to: '/org/roles' },
    { key: 'sites', label: 'Sites', value: src ? String(src.sites.length) : '—', sub: 'Offices and locations', to: '/org/sites' },
    { key: 'domain', label: 'Domain', value: dom ? dom.label : '—', color: dom?.color, sub: src ? (src.domain.allowed_domain ?? 'No domain yet') : '', to: '/org/domain' },
  ];

  return (
    <>
      <OrgPageHeader
        section="overview"
        actions={
          <button type="button" className="ox-btn ox-btn--primary" onClick={() => setInviteOpen(true)} data-testid="overview-invite">
            Invite user
          </button>
        }
      />
      <div className="ov-stack">
        {data.status === 'error' ? (
          <div className="ox-alert ox-alert--error" role="alert">
            Some organization details couldn’t be loaded.{' '}
            <button type="button" className="ox-link" onClick={data.refresh}>
              Try again
            </button>
          </div>
        ) : null}
        <div className="ov-tiles" aria-busy={data.status === 'loading'}>
          {tiles.map((t) => (
            <Link key={t.key} to={t.to} className="ov-tile" data-testid={`overview-tile-${t.key}`}>
              <span className="ov-tile__label">{t.label}</span>
              <span className="ov-tile__value" style={t.color ? { color: t.color } : undefined}>
                {t.value}
              </span>
              <span className="ov-tile__sub">{t.sub}</span>
            </Link>
          ))}
        </div>
        <div className="ov-cards">
          <section className="ox-card ov-card" aria-labelledby="ov-setup-title" data-testid="overview-checklist">
            <div className="ox-card__head">
              <div>
                <h2 id="ov-setup-title" className="ox-card__title">
                  Setup checklist
                </h2>
                <p className="ox-card__sub">{checklist.status === 'ready' ? `${checklist.done} of ${checklist.total} done` : checklist.status === 'loading' ? 'Loading…' : '—'}</p>
              </div>
              {checklist.status === 'ready' ? (
                <span className="ov-bar" aria-hidden="true">
                  <span style={{ width: `${Math.round((checklist.done / checklist.total) * 100)}%` }} />
                </span>
              ) : null}
            </div>
            {checklist.status === 'ready' ? (
              checklist.items.map((it) => <ChecklistRow key={it.key} item={it} />)
            ) : checklist.status === 'error' ? (
              <p className="ov-empty">The checklist couldn’t be loaded.</p>
            ) : null}
          </section>
          <section className="ox-card ov-card" aria-labelledby="ov-recent-title" data-testid="overview-recent">
            <div className="ox-card__head">
              <div>
                <h2 id="ov-recent-title" className="ox-card__title">
                  Recent changes
                </h2>
              </div>
              <Link to="/org/audit" className="ov-audit-link">
                View audit →
              </Link>
            </div>
            {audit.status === 'ready' ? (
              audit.items.length === 0 ? (
                <p className="ov-empty">No changes yet.</p>
              ) : (
                audit.items.map((a) => (
                  <div className="ov-audit-row" key={a.id} data-testid="overview-audit-row">
                    <span className="ov-audit-when">{shortWhen(a.created_at)}</span>
                    <span className="ov-audit-text">
                      <b>{a.actor.display}</b> {eventTypeLabel(a.event_type).toLowerCase()} {a.detail ? <span className="ov-audit-target">{a.detail}</span> : null}
                    </span>
                  </div>
                ))
              )
            ) : audit.status === 'error' ? (
              <p className="ov-empty">Recent changes couldn’t be loaded.</p>
            ) : null}
          </section>
        </div>
      </div>
      <InviteUserModal open={inviteOpen} onOpenChange={setInviteOpen} onInvited={data.refresh} />
    </>
  );
}

function ChecklistRow({ item }: { readonly item: SetupItem }) {
  return (
    <Link to={item.path} className="ov-check-row" data-testid={`setup-item-${item.key}`}>
      <span className={item.done ? 'ov-dot ov-dot--done' : 'ov-dot'} aria-hidden="true">
        {item.done ? '✓' : ''}
      </span>
      <span className="ov-check-text">
        <span className="ov-check-label">
          {item.label}
          <span className="ox-sr-only">{item.done ? ' (done)' : ' (not done)'}</span>
        </span>
        <span className={item.done ? 'ov-check-hint ov-check-hint--done' : 'ov-check-hint'}>{item.hint}</span>
      </span>
      <span className="ov-check-cta">{item.done ? 'View' : 'Finish'}</span>
    </Link>
  );
}
