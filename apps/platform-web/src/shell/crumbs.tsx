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
/**
 * The entity-crumb setter itself (TEMPLATE-STUDIO-1 S-0), for a shared component that
 * reports its entity name through a callback (the lib Template Studio's onEntityName)
 * instead of calling useEntityCrumb. Stable across renders.
 */
export function useSetEntityCrumb(): (label: string | null) => void {
  return useContext(CrumbContext).setEntity;
}

export function useEntityCrumb(label: string | null | undefined): void {
  const { setEntity } = useContext(CrumbContext);
  useEffect(() => {
    setEntity(label ?? null);
    return () => setEntity(null);
  }, [label, setEntity]);
}
