import { AramoRail, type AramoRailItem } from '@aramo/fe-foundation';
import { useLocation } from 'react-router-dom';

// The ATS item set for the shared main left nav. The rail itself (markup,
// geometry, collapse) is the shared @aramo/fe-foundation AramoRail — moved from
// this file so App Home and Organization administration render the same rail.
// Design authority: aramo-Prototype platform/Requisitions CRM.dc.html.

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

export interface AppRailProps {
  readonly primary: readonly RailItem[];
  readonly work: readonly RailItem[];
  readonly admin: readonly RailItem[];
  readonly userInitials: string;
  readonly userName: string;
  readonly tenantName: string | null;
}

export function AppRail({ primary, work, admin, userInitials, userName, tenantName }: AppRailProps): JSX.Element {
  const { pathname } = useLocation();
  const toItem = (it: RailItem): AramoRailItem => ({
    key: it.key,
    to: it.to,
    label: it.label,
    iconPath: RAIL_ICONS[it.key],
    gear: it.key === 'settings',
    ...(it.count !== undefined ? { count: it.count } : {}),
  });
  return (
    <AramoRail
      sections={[
        { kind: 'primary', items: primary.map(toItem) },
        { label: 'Work', kind: 'work', items: work.map(toItem) },
        { label: 'Administration', kind: 'work', items: admin.map(toItem) },
      ]}
      activeKey={activeRailKey(pathname)}
      userInitials={userInitials}
      userName={userName}
      tenantName={tenantName}
      homeTo="/"
      homeLabel="My desk"
    />
  );
}
