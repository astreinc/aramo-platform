import { Link } from 'react-router-dom';

import { Button } from '../components/Button';

import { useNavCollapse } from './nav-collapse';

// The shared main left nav (app rail) — ONE component for every authenticated
// page of every Aramo app on the tenant host (App Home, Organization
// administration, ATS). Generalised from apps/ats-web/src/shell/AppRail.tsx
// (move-not-fork): the ATS keeps its own item set, icons and active-route map and
// renders through this component. Design authority: aramo-Prototype
// platform/Requisitions CRM.dc.html (railVals()) and the accepted
// "Main left nav — shared component" handoff. Geometry and colours: app-rail.css.

export interface AramoRailItem {
  readonly key: string;
  /** Router path inside the current app (react-router <Link>). */
  readonly to: string;
  readonly label: string;
  /** 24-viewBox stroke path(s) for the 20px icon. */
  readonly iconPath: string;
  /** Adds the Settings gear's centre circle. */
  readonly gear?: boolean;
  /** Badge count (omitted when 0). */
  readonly count?: number;
}

export interface AramoRailSection {
  /** Section label (expanded) / divider (collapsed). Omit for the top group. */
  readonly label?: string;
  /** Primary items hover brighter than work/admin items (rail spec §4). */
  readonly kind: 'primary' | 'work';
  readonly items: readonly AramoRailItem[];
}

export interface AramoRailProps {
  readonly sections: readonly AramoRailSection[];
  /** The key of the active item (aria-current="page"), or null. */
  readonly activeKey: string | null;
  readonly userInitials: string;
  readonly userName: string;
  readonly tenantName: string | null;
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

function ItemIcon({ item }: { item: AramoRailItem }): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {item.gear ? <circle cx="12" cy="12" r="3.2" /> : null}
      <path d={item.iconPath} />
    </svg>
  );
}

function RailLink({ item, active, kind }: { item: AramoRailItem; active: boolean; kind: 'primary' | 'work' }): JSX.Element {
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
      <ItemIcon item={item} />
      <span className="ats-rail__label">{item.label}</span>
      {count !== null ? <span className="ats-rail__count">{count}</span> : null}
    </Link>
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

export function AramoRail({ sections, activeKey, userInitials, userName, tenantName }: AramoRailProps): JSX.Element {
  const { collapsed, toggle } = useNavCollapse();
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

      {sections.map((section, i) =>
        section.items.length === 0 ? null : (
          <div key={section.label ?? `s${i}`} className="ats-rail__group">
            {section.label !== undefined ? <RailSection label={section.label} /> : null}
            {section.items.map((it) => (
              <RailLink key={it.key} item={it} active={activeKey === it.key} kind={section.kind} />
            ))}
          </div>
        ),
      )}

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
