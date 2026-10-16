import { Button } from '@aramo/fe-foundation';
import { Fragment, useEffect, useState } from 'react';

import './section-nav.css';

// The shared talent SECTION nav (232px expanded / 60px collapsed) used by both
// Talent 360 and Talent × Requisition 360, so the two cannot drift. Design
// authority: aramo-Prototype platform/Talent 360 CRM.dc.html and
// platform/Talent Requisition 360.dc.html. The two specs differ in a few
// normative values (groups + headings, list/item padding, avatar tint, whether
// the nav scrolls on its own) — expressed as the `variant` modifier, nothing else.

export type SectionNavVariant = 'talent' | 'opportunity';
export type SectionBadgeTone = 'grey' | 'blue' | 'amber';

export interface SectionNavItem {
  readonly key: string;
  readonly label: string;
  /** Path data (24 viewBox, stroked). */
  readonly icon: string;
  readonly badge?: { readonly text: string; readonly tone: SectionBadgeTone };
}

export interface SectionNavGroup {
  /** Group heading (expanded only); omit for an ungrouped list. */
  readonly label?: string;
  readonly items: readonly SectionNavItem[];
}

export interface SectionNavProps {
  readonly variant: SectionNavVariant;
  readonly ariaLabel: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly backLabel: string;
  readonly onBack: () => void;
  readonly initials: string;
  readonly name: string;
  readonly subtitle?: string;
  readonly pill?: string;
  readonly groups: readonly SectionNavGroup[];
  readonly active: string | null;
  readonly onSelect: (key: string) => void;
}

const BACK = 'M19 12H5M11 18l-6-6 6-6';

function Glyph({ d, size, width }: { d: string; size: number; width: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function SectionNav({
  variant,
  ariaLabel,
  open,
  onToggle,
  backLabel,
  onBack,
  initials,
  name,
  subtitle,
  pill,
  groups,
  active,
  onSelect,
}: SectionNavProps): JSX.Element {
  const tip = open ? 'Collapse talent sections' : 'Expand talent sections';
  return (
    <nav aria-label={ariaLabel} className={`secnav secnav--${variant}${open ? '' : ' secnav--collapsed'}`}>
      <div className="secnav__inner">
        <div className="secnav__top">
          {open ? (
            <Button unstyled type="button" className="secnav__back" title={backLabel} onClick={onBack}>
              <Glyph d={BACK} size={13} width={2.2} />
              <span>{backLabel}</span>
            </Button>
          ) : null}
          <Button unstyled type="button" className="secnav__toggle" title={tip} aria-label={tip} aria-expanded={open} onClick={onToggle}>
            <Glyph d={open ? 'M4 4h16v16H4zM9 4v16M15 10l-2 2 2 2' : 'M4 4h16v16H4zM9 4v16M13 10l2 2-2 2'} size={14} width={2} />
          </Button>
        </div>
        <div className="secnav__who">
          <span className="secnav__avatar" aria-hidden="true">
            {initials}
          </span>
          {open ? (
            <span className="secnav__whotext">
              <span className="secnav__name">{name}</span>
              {subtitle !== undefined && subtitle !== '' ? <span className="secnav__subtitle">{subtitle}</span> : null}
              {pill !== undefined ? <span className="secnav__pill">{pill}</span> : null}
            </span>
          ) : null}
        </div>
        <div className="secnav__list">
          {!open ? (
            <Button unstyled type="button" className="secnav__backitem" title={backLabel} aria-label={backLabel} onClick={onBack}>
              <Glyph d={BACK} size={16} width={1.8} />
            </Button>
          ) : null}
          {groups.map((g, gi) => (
            <Fragment key={g.label ?? `g${gi}`}>
              {open && g.label !== undefined ? <div className="secnav__group">{g.label}</div> : null}
              {!open && gi > 0 && g.label !== undefined ? <div className="secnav__sep" role="separator" /> : null}
              {g.items.map((it) => {
                const on = active === it.key;
                return (
                  <Button
                    unstyled
                    key={it.key}
                    type="button"
                    className={`secnav__item${on ? ' secnav__item--on' : ''}`}
                    title={it.label}
                    aria-label={open ? undefined : it.label}
                    aria-current={on ? 'page' : undefined}
                    onClick={() => onSelect(it.key)}
                  >
                    <Glyph d={it.icon} size={16} width={1.8} />
                    {open ? <span className="secnav__label">{it.label}</span> : null}
                    {open && it.badge !== undefined ? (
                      <span className={`secnav__badge secnav__badge--${it.badge.tone}`}>{it.badge.text}</span>
                    ) : null}
                  </Button>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </nav>
  );
}

/**
 * Section-nav open state: a user preference (persisted under `storageKey` when
 * given), auto-collapsed below 900px viewport regardless of the preference.
 */
export function useSectionNavOpen(storageKey?: string): readonly [boolean, () => void] {
  const [pref, setPref] = useState<boolean>(() => {
    if (storageKey === undefined) return true;
    try {
      const v = window.localStorage.getItem(storageKey);
      return v === null ? true : v === '1';
    } catch {
      return true;
    }
  });
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 900);
  // An explicit toggle wins until the viewport crosses the 900px threshold again.
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => setOverride(null), [narrow]);
  const open = override ?? (pref && !narrow);
  const toggle = (): void => {
    const next = !open;
    setOverride(next);
    setPref(next);
    if (storageKey !== undefined) {
      try {
        window.localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        /* storage unavailable — the toggle still works for the visit */
      }
    }
  };
  return [open, toggle] as const;
}
