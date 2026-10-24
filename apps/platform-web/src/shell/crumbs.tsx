import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

// PLATFORM-UX-1 F-2 — the entity crumb (handoff §3.4: the breadcrumb always ends
// in the ENTITY NAME). A detail page calls useEntityCrumb(name) once it knows the
// name; the shell's breadcrumb shows the generic label until then.

interface CrumbContextValue {
  readonly entity: string | null;
  readonly setEntity: (label: string | null) => void;
}

const CrumbContext = createContext<CrumbContextValue>({
  entity: null,
  setEntity: () => {
    /* no-op outside the shell (tests that render a page alone) */
  },
});

export function CrumbProvider({ children }: { readonly children: ReactNode }) {
  const [entity, setEntity] = useState<string | null>(null);
  const value = useMemo(() => ({ entity, setEntity }), [entity]);
  return <CrumbContext.Provider value={value}>{children}</CrumbContext.Provider>;
}

/** The current entity crumb (shell use). */
export function useCrumbEntity(): string | null {
  return useContext(CrumbContext).entity;
}

/**
 * Sets the last breadcrumb to `label` (e.g. the tenant name) while the calling
 * page is mounted. Pass null/undefined while the name is still loading.
 */
export function useEntityCrumb(label: string | null | undefined): void {
  const { setEntity } = useContext(CrumbContext);
  useEffect(() => {
    setEntity(label ?? null);
    return () => setEntity(null);
  }, [label, setEntity]);
}
