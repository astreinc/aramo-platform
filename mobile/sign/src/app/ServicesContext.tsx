import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';

import type { SessionSnapshot } from '../auth/session';
import type { AppServices } from './services';

const ServicesContext = createContext<AppServices | null>(null);

export function ServicesProvider({
  services,
  children,
}: {
  readonly services: AppServices;
  readonly children: ReactNode;
}) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): AppServices {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('useServices outside ServicesProvider');
  return s;
}

/** The live session state (restoring / signedOut / signedIn and why). */
export function useSession(): SessionSnapshot {
  const { session } = useServices();
  return useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
}
