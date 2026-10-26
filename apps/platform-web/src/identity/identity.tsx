import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { hasScope, type Session } from '@aramo/fe-foundation';

import { platformApi, type PlatformMe } from '../platform-api';

// PLATFORM-UX-1 F-2 (directive R-6) — the signed-in operator's identity for the
// environment bar, rail footer, account menu and access-denied card.
//
// The source is GET /platform/me (B-1a, caller only). Until it resolves — and
// whenever it is refused or fails — every surface shows the designed fallback:
// the session `sub` and `tenant_id`. The shared Session type is not changed.
// /platform/me needs platform:tenant:read, so a session without it skips the
// call and stays on the fallback (it would only be refused).

export type IdentityStatus = 'loading' | 'resolved' | 'fallback';

export interface OperatorIdentity {
  readonly status: IdentityStatus;
  /** Email, or the session subject while unresolved. */
  readonly email: string;
  /** Display name, else email, else the session subject. */
  readonly name: string;
  /** Tenant name, or the session tenant id while unresolved. */
  readonly tenant: string;
  /** "Super admin"; null while unresolved or when the caller holds no role. */
  readonly role: string | null;
  /** Up to 2 initials; "?" when unresolved. */
  readonly initials: string;
}

const ROLE_LABEL: Readonly<Record<string, string>> = {
  super_admin: 'Super admin',
  // CCP-B1 — the six commercial platform roles (CCP-UI v1.0 handoff §3).
  platform_owner: 'Platform owner',
  finance_admin: 'Finance admin',
  commercial_ops: 'Commercial ops',
  catalog_manager: 'Catalog manager',
  support_admin: 'Support admin',
  read_only_auditor: 'Read-only auditor',
};

/** Human label for a role key: known keys from the table, others "snake_case" → "Snake case". */
export function roleKeyLabel(key: string): string {
  const known = ROLE_LABEL[key];
  if (known !== undefined) return known;
  const words = key.replace(/[_.:-]+/g, ' ').trim().toLowerCase();
  return words.length === 0 ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

/** All roles joined; null when there are none. */
export function roleLabel(keys: readonly string[]): string | null {
  return keys.length === 0 ? null : keys.map(roleKeyLabel).join(', ');
}

/** "Maya Okafor" → "MO"; "maya.okafor@aramo.ai" → "MO"; empty → "?". */
export function initialsOf(nameOrEmail: string | null | undefined): string {
  const raw = (nameOrEmail ?? '').trim();
  if (raw.length === 0) return '?';
  const base = raw.includes('@') ? raw.slice(0, raw.indexOf('@')) : raw;
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : base.slice(0, 2);
  return letters.toUpperCase() || '?';
}

export function identityFrom(session: Session, me: PlatformMe | null, status: IdentityStatus): OperatorIdentity {
  if (me === null) {
    return {
      status,
      email: session.sub,
      name: session.sub,
      tenant: session.tenant_id,
      role: null,
      initials: '?',
    };
  }
  const name = me.display_name?.trim() ? me.display_name.trim() : me.email;
  return {
    status: 'resolved',
    email: me.email,
    name,
    tenant: me.tenant_name || me.tenant_id,
    role: roleLabel(me.role_keys),
    initials: initialsOf(me.display_name?.trim() ? me.display_name : me.email),
  };
}

export type LoadMe = () => Promise<PlatformMe>;

/** Resolves the operator identity for `session` (fallback until /platform/me answers). */
export function useOperatorIdentity(session: Session, load: LoadMe = platformApi.getMe): OperatorIdentity {
  const canRead = hasScope(session, 'platform:tenant:read');
  const [state, setState] = useState<{ me: PlatformMe | null; status: IdentityStatus }>({
    me: null,
    status: canRead ? 'loading' : 'fallback',
  });

  useEffect(() => {
    if (!canRead) {
      setState({ me: null, status: 'fallback' });
      return undefined;
    }
    let cancelled = false;
    setState({ me: null, status: 'loading' });
    load().then(
      (me) => {
        if (!cancelled) setState({ me, status: 'resolved' });
      },
      () => {
        if (!cancelled) setState({ me: null, status: 'fallback' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [canRead, load, session.sub]);

  return useMemo(() => identityFrom(session, state.me, state.status), [session, state]);
}

const IdentityContext = createContext<OperatorIdentity | null>(null);

export interface IdentityProviderProps {
  readonly session: Session;
  readonly children: ReactNode;
  /** Test seam: the /platform/me loader. */
  readonly load?: LoadMe;
}

export function IdentityProvider({ session, children, load }: IdentityProviderProps) {
  const identity = useOperatorIdentity(session, load);
  return <IdentityContext.Provider value={identity}>{children}</IdentityContext.Provider>;
}

/** The operator identity from the nearest IdentityProvider (PlatformShell mounts one). */
export function useIdentity(): OperatorIdentity {
  const value = useContext(IdentityContext);
  if (value === null) throw new Error('useIdentity must be used inside <IdentityProvider>');
  return value;
}
