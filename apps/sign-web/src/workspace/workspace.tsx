import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '@aramo/fe-foundation';

import { senderApi, type SenderContext } from './api';

// The authenticated sender context (GET /v1/sign/sender/context): tenant, kind,
// workspace and permissions — ALL decided by the backend. The SPA's route prefix
// (/sign/ vs /personal/) is derived from it and never authorizes anything.

export type Workspace = 'sign' | 'personal';

export interface WorkspaceValue {
  ctx: SenderContext;
  base: '/sign' | '/personal';
  // Envelopes awaiting signature (sidebar badge); refreshed after mutations.
  awaiting: number;
  refreshCounts: () => void;
  toast: (message: string) => void;
}

const WorkspaceCtx = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const v = useContext(WorkspaceCtx);
  if (v === null) throw new Error('useWorkspace outside WorkspaceProvider');
  return v;
}

export function WorkspaceProvider({ ctx, children }: { ctx: SenderContext; children: ReactNode }) {
  const [awaiting, setAwaiting] = useState(0);
  const [tick, setTick] = useState(0);
  const [toastMsg, setToastMsg] = useState('');
  useEffect(() => {
    let live = true;
    senderApi
      .summary()
      .then((s) => {
        if (live) setAwaiting(s.awaiting_signatures);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [tick]);
  useEffect(() => {
    if (toastMsg === '') return undefined;
    const t = setTimeout(() => setToastMsg(''), 3000);
    return () => clearTimeout(t);
  }, [toastMsg]);
  const refreshCounts = useCallback(() => setTick((n) => n + 1), []);
  const toast = useCallback((m: string) => setToastMsg(m), []);
  return (
    <WorkspaceCtx.Provider value={{ ctx, base: ctx.workspace === 'personal' ? '/personal' : '/sign', awaiting, refreshCounts, toast }}>
      {children}
      {toastMsg !== '' ? (
        <div className="sg-toast" role="status">
          {toastMsg}
        </div>
      ) : null}
    </WorkspaceCtx.Provider>
  );
}

export type ContextState =
  | { status: 'loading' }
  | { status: 'ready'; ctx: SenderContext }
  | { status: 'not_entitled' }
  | { status: 'no_access' }
  | { status: 'error'; message: string };

// Loads the sender context once. A tenant without the Sign subscription gets a
// clear refusal page — login success alone never grants access.
export function useSenderContext(loader: () => Promise<SenderContext> = senderApi.context): ContextState & { retry: () => void } {
  const [state, setState] = useState<ContextState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    loader()
      .then((ctx) => {
        if (live) setState({ status: 'ready', ctx });
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.code === 'TENANT_CAPABILITY_NOT_ENTITLED') setState({ status: 'not_entitled' });
        else if (e instanceof ApiError && e.status === 403) setState({ status: 'no_access' });
        else setState({ status: 'error', message: e instanceof Error ? e.message : 'Could not load Aramo Sign' });
      });
    return () => {
      live = false;
    };
  }, [loader, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}
