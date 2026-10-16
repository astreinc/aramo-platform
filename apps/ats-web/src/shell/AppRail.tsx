import { Button } from '@aramo/fe-foundation';
import { Link, useLocation } from 'react-router-dom';

import { useNavCollapse } from './nav-collapse';

// The shared main left nav (app rail) — ONE component for every authenticated
// page. Design authority: aramo-Prototype platform/Requisitions CRM.dc.html
// (rail markup + railVals()). Geometry and colours live in app-rail.css.

export type RailKey =
  | 'desk'
  | 'requisitions'
  | 'placements'
  | 'talent'
  | 'companies'
  | 'contacts'
  | 'sourcing'
  | 'tasks'
  | 'advisories'
  | 'disputes'
  | 'proposals'
  | 'reports'
  | 'settings';

export interface RailItem {
  readonly key: RailKey;
  readonly to: string;
  readonly label: string;
  /** Badge count (omitted when 0); the icon is RAIL_ICONS[key]. */
  readonly count?: number;
}

export const RAIL_ICONS: Record<RailKey, string> = {
  desk: 'M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
  requisitions: 'M3 9h18M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  placements: 'M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 13h18',
  talent: 'M12 11.2a3.2 3.2 0 1 0-6.4 0 3.2 3.2 0 0 0 6.4 0zM3 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6M17.5 20a5.6 5.6 0 0 0-2-4.3',
  companies: 'M4 21V6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15M14 10h5a1 1 0 0 1 1 1v10M2 21h20',
  contacts: 'M20 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3M9.4 12a2.6 2.6 0 1 0 5.2 0 2.6 2.6 0 0 0-5.2 0z',
  sourcing: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5',
  tasks: 'M9 5h9M9 12h9M9 19h9M4 5l1.4 1.4L8 4M4 12l1.4 1.4L8 11M4 19l1.4 1.4L8 18',
  advisories: 'M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6zM12 8.5v4M12 16h.01',
  disputes: 'M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6zM9.5 10.5h5M9.5 13.5h5',
  proposals: 'M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6zM9 12l2 2 4-4.5',
  reports: 'M4 20V10M10 20V4M16 20v-7M2 20h20',
  settings: 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1',
};

/** The active rail item for a route (spec §5). */
export function activeRailKey(pathname: string): RailKey | null {
  const p = pathname.replace(/\/+$/, '') || '/';
  const under = (prefix: string): boolean => p === prefix || p.startsWith(`${prefix}/`);
  if (p === '/') return 'desk';
  // Submittal Workspace lives under /talent/... but belongs to Requisitions.
  if (/^\/talent\/[^/]+\/submittal(\/|$)/.test(p)) return 'requisitions';
  if (under('/requisitions')) return 'requisitions';
  if (under('/placements') || under('/offer-start')) return 'placements';
  if (under('/talent')) return 'talent';
  if (under('/companies')) return 'companies';
  if (under('/contacts')) return 'contacts';
  if (under('/sourcing')) return 'sourcing';
  if (under('/tasks')) return 'tasks';
  if (under('/identity/advisories')) return 'advisories';
  if (under('/identity/portal-disputes')) return 'disputes';
  if (under('/trust/proposals')) return 'proposals';
  if (under('/reports')) return 'reports';
  if (under('/admin') || under('/settings')) return 'settings';
  return null;
}

function AramoMark(): JSX.Element {
  return (
    <svg width="25" height="25" viewBox="0 0 64 64" aria-hidden="true">
      <g stroke="#FFFFFF" strokeWidth="5" strokeLinecap="round">
        <line x1="43" y1="32" x2="56" y2="32" />
        <line x1="32" y1="43" x2="32" y2="56" />
        <line x1="24.2" y1="39.8" x2="15" y2="49" />
        <line x1="21" y1="32" x2="8" y2="32" />
        <line x1="24.2" y1="24.2" x2="15" y2="15" />
        <line x1="32" y1="21" x2="32" y2="8" />
        <line x1="39.8" y1="39.8" x2="49" y2="49" />
      </g>
      <line x1="39.8" y1="24.2" x2="54.5" y2="9.5" stroke="#d97757" strokeWidth="6" strokeLinecap="round" />
      <circle cx="32" cy="32" r="6" fill="#FFFFFF" />
    </svg>
  );
}

function ItemIcon({ k }: { k: RailKey }): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {k === 'settings' ? <circle cx="12" cy="12" r="3.2" /> : null}
      <path d={RAIL_ICONS[k]} />
    </svg>
  );
}

function RailLink({ item, active, kind }: { item: RailItem; active: boolean; kind: 'primary' | 'work' }): JSX.Element {
  const count = item.count !== undefined && item.count > 0 ? item.count : null;
  const tip = count !== null ? `${item.label} · ${count}` : item.label;
  return (
    <Link
      to={item.to}
      title={tip}
      aria-label={tip}
      aria-current={active ? 'page' : undefined}
      className={`ats-rail__item ats-rail__item--${kind}${active ? ' ats-rail__item--on' : ''}`}
    >
      <ItemIcon k={item.key} />
      <span className="ats-rail__label">{item.label}</span>
      {count !== null ? <span className="ats-rail__count">{count}</span> : null}
    </Link>
  );
}

export interface AppRailProps {
  readonly primary: readonly RailItem[];
  readonly work: readonly RailItem[];
  readonly admin: readonly RailItem[];
  readonly userInitials: string;
  readonly userName: string;
  readonly tenantName: string | null;
}

export function AppRail({ primary, work, admin, userInitials, userName, tenantName }: AppRailProps): JSX.Element {
  const { collapsed, toggle } = useNavCollapse();
  const { pathname } = useLocation();
  const active = activeRailKey(pathname);

  return (
    <aside className={`ats-rail${collapsed ? ' ats-rail--collapsed' : ''}`} aria-label="Main navigation">
      <div className="ats-rail__head">
        {collapsed ? (
          <Button
            unstyled
            type="button"
            className="ats-rail__logo ats-rail__logo--open"
            title="Open sidebar"
            aria-label="Open sidebar"
            aria-expanded={false}
            onClick={toggle}
          >
            <AramoMark />
          </Button>
        ) : (
          <>
            <span className="ats-rail__logo" title="Aramo">
              <AramoMark />
            </span>
            <span className="ats-rail__word">
              aramo<span className="ats-rail__ai">.ai</span>
            </span>
            <Button
              unstyled
              type="button"
              className="ats-rail__collapse"
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
              aria-expanded
              onClick={toggle}
            >
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
                <line x1="9.5" y1="4.5" x2="9.5" y2="19.5" />
              </svg>
            </Button>
          </>
        )}
      </div>

      {primary.map((it) => (
        <RailLink key={it.key} item={it} active={active === it.key} kind="primary" />
      ))}

      {work.length > 0 ? (
        <>
          <RailSection label="Work" />
          {work.map((it) => (
            <RailLink key={it.key} item={it} active={active === it.key} kind="work" />
          ))}
        </>
      ) : null}

      {admin.length > 0 ? (
        <>
          <RailSection label="Administration" />
          {admin.map((it) => (
            <RailLink key={it.key} item={it} active={active === it.key} kind="work" />
          ))}
        </>
      ) : null}

      <div className="ats-rail__foot">
        <span className="ats-rail__avatar" aria-hidden="true">
          {userInitials}
        </span>
        <span className="ats-rail__who">
          <span className="ats-rail__name" title={userName}>
            {userName}
          </span>
          {tenantName !== null ? (
            <span className="ats-rail__tenant" title={tenantName}>
              {tenantName}
            </span>
          ) : null}
        </span>
      </div>
    </aside>
  );
}

function RailSection({ label }: { label: string }): JSX.Element {
  const { collapsed } = useNavCollapse();
  return collapsed ? (
    <div className="ats-rail__divider" role="separator" aria-label={label} />
  ) : (
    <div className="ats-rail__section">{label}</div>
  );
}
