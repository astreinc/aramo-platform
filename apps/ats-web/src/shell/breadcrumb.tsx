import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

// Breadcrumb entity context (2D ruling). A detail surface publishes its entity
// title; the TopBar appends it to the route-derived section crumb
// (e.g. "Requisitions › Senior Rust Engineer"). The provider sits ABOVE both the
// TopBar (reader) and the routed children (writers) in RecruiterShell, so a
// child's useEntityCrumb() update flows up to the breadcrumb without prop
// drilling. Cleared automatically on unmount (route change).

interface BreadcrumbContextValue {
  readonly entity: string | null;
  readonly setEntity: (label: string | null) => void;
}

const BreadcrumbContext = createContext<BreadcrumbContextValue>({
  entity: null,
  setEntity: () => undefined,
});

export function BreadcrumbProvider({ children }: { readonly children: ReactNode }) {
  const [entity, setEntity] = useState<string | null>(null);
  const value = useMemo(() => ({ entity, setEntity }), [entity]);
  return (
    <BreadcrumbContext.Provider value={value}>
      {children}
    </BreadcrumbContext.Provider>
  );
}

// Read the current entity crumb (TopBar consumer).
export function useBreadcrumbEntity(): string | null {
  return useContext(BreadcrumbContext).entity;
}

// Publish this surface's entity title to the breadcrumb; clears on unmount or
// when the label becomes null (e.g. while loading).
export function useEntityCrumb(label: string | null | undefined): void {
  const { setEntity } = useContext(BreadcrumbContext);
  useEffect(() => {
    setEntity(label ?? null);
    return () => setEntity(null);
  }, [label, setEntity]);
}
