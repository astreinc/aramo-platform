// The signed-in shell's side menu, openable from any root tab (M-A4 §1.4). MainTabs
// wraps the tab navigator in <ShellProvider>; the top bar's ☰ calls useShell().openMenu().
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { SideMenu } from './SideMenu';

interface ShellApi {
  readonly openMenu: () => void;
  readonly closeMenu: () => void;
  readonly menuOpen: boolean;
}

const noop = () => undefined;
const ShellContext = createContext<ShellApi>({ openMenu: noop, closeMenu: noop, menuOpen: false });

export function useShell(): ShellApi {
  return useContext(ShellContext);
}

export function ShellProvider({ children }: { readonly children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const api = useMemo(() => ({ openMenu, closeMenu, menuOpen }), [openMenu, closeMenu, menuOpen]);
  return (
    <ShellContext.Provider value={api}>
      {children}
      <SideMenu open={menuOpen} onClose={closeMenu} />
    </ShellContext.Provider>
  );
}
