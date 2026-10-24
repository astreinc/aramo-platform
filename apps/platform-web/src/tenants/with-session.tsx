import type { ReactElement } from 'react';
import { useSession, type Session } from '@aramo/fe-foundation';

import { SkeletonPanel } from '../components';

// PLATFORM-UX-1 F-3/F-4 — the session for a view's permission gates. App.tsx
// passes `session` to the views it already wires; a view mounted without it
// (Dashboard, Tenants list, Provision are routed without the prop today) reads
// the session itself, once, and renders a skeleton until it resolves. The
// server stays authoritative either way.

export function WithSession({
  session,
  children,
}: {
  readonly session: Session | undefined;
  readonly children: (session: Session) => ReactElement;
}): ReactElement {
  return session !== undefined ? children(session) : <SessionReader>{children}</SessionReader>;
}

function SessionReader({ children }: { readonly children: (session: Session) => ReactElement }): ReactElement {
  const state = useSession();
  if (state.status === 'authenticated') return children(state.session);
  return <SkeletonPanel />;
}
