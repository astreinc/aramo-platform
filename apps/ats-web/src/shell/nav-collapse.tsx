import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

// Shared main-nav (app rail) collapse — ONE user preference for every page.
// Stored as `aramo.nav.collapsed` ('1' / '0'); there is no server-side user
// preference store, so localStorage it is. Read synchronously on mount so the
// rail renders in the stored state with no expand/collapse flash; every toggle
// writes through immediately. The pre-spec key (`rc-rail-collapsed`) is
// migrated once so an existing choice is kept.
//
// Pages with a secondary section nav (Talent × Requisition 360) call
// useCompactRailPage(): under 1280px the rail opens collapsed regardless of the
// stored value; an explicit toggle during that visit wins (and is written
// through as usual). At 1280px and wider the stored value applies.

export const NAV_COLLAPSED_KEY = 'aramo.nav.collapsed';
const LEGACY_KEY = 'rc-rail-collapsed';
const COMPACT_BELOW = 1280;

export function readNavCollapsed(): boolean {
  try {
    const v = window.localStorage.getItem(NAV_COLLAPSED_KEY);
    if (v === '1' || v === '0') return v === '1';
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (legacy === '1' || legacy === '0') {
      window.localStorage.setItem(NAV_COLLAPSED_KEY, legacy);
      return legacy === '1';
    }
  } catch {
    /* storage unavailable — default expanded */
  }
  return false;
}

function writeNavCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    /* storage unavailable — the toggle still works for the session */
  }
}

export interface NavCollapse {
  /** The effective state the rail renders in. */
  readonly collapsed: boolean;
  readonly toggle: () => void;
  /** @internal — registered by useCompactRailPage. */
  readonly setCompactPage: (on: boolean) => void;
}

const NavCollapseContext = createContext<NavCollapse>({
  collapsed: false,
  toggle: () => undefined,
  setCompactPage: () => undefined,
});

export function useNavCollapse(): NavCollapse {
  return useContext(NavCollapseContext);
}

function viewportWidth(): number {
  return typeof window === 'undefined' ? Infinity : window.innerWidth;
}

export function NavCollapseProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [stored, setStored] = useState<boolean>(readNavCollapsed);
  const [compactPage, setCompactPageState] = useState(false);
  // An explicit toggle during a compact-page visit wins for that visit.
  const [visitOverride, setVisitOverride] = useState<boolean | null>(null);

  const collapsed =
    compactPage && visitOverride !== null
      ? visitOverride
      : compactPage && viewportWidth() < COMPACT_BELOW
        ? true
        : stored;

  const toggle = useCallback(() => {
    const next = !collapsed;
    if (compactPage) setVisitOverride(next);
    setStored(next);
    writeNavCollapsed(next);
  }, [collapsed, compactPage]);

  const setCompactPage = useCallback((on: boolean) => {
    setCompactPageState(on);
    setVisitOverride(null);
  }, []);

  // ⌘\ / Ctrl+\ on every page (same write-through as the buttons).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        toggle();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggle]);

  const value = useMemo<NavCollapse>(() => ({ collapsed, toggle, setCompactPage }), [collapsed, toggle, setCompactPage]);
  return <NavCollapseContext.Provider value={value}>{children}</NavCollapseContext.Provider>;
}

/** Call from a page that has its own secondary section nav (see header comment). */
export function useCompactRailPage(): void {
  const { setCompactPage } = useNavCollapse();
  // Layout effect: applied before the page's first paint (no expanded flash).
  useLayoutEffect(() => {
    setCompactPage(true);
    return () => setCompactPage(false);
  }, [setCompactPage]);
}
