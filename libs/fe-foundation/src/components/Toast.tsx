import * as RadixToast from '@radix-ui/react-toast';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

interface ToastItem {
  id: string;
  message: string;
}

interface ToastApi {
  show: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const show = useCallback((message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, message }]);
  }, []);

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={api}>
      <RadixToast.Provider swipeDirection="right" duration={3000}>
        {children}
        {toasts.map((t) => (
          <RadixToast.Root
            key={t.id}
            className="tc-toast"
            onOpenChange={(open) => {
              if (!open) remove(t.id);
            }}
          >
            <RadixToast.Description>{t.message}</RadixToast.Description>
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className="tc-toast-viewport" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return ctx;
}

// A non-throwing accessor: returns the toast API when a ToastProvider is present,
// else a no-op. For components that MAY be mounted outside a provider (e.g. in
// isolated test renders or embedded surfaces) and treat a toast as an optional
// enhancement rather than a hard dependency. Never throws.
const NOOP_TOAST: ToastApi = { show: () => undefined };
export function useOptionalToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP_TOAST;
}
