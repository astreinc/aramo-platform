// Aramo-Identity-Me-Endpoint-UserMenu-Directive-v1_0 — the /me read client.
//
//   GET /v1/me -> Me
//
// The DISPLAY companion to the lean session JWT (which carries only sub /
// consumer_type / tenant_id / scopes / iat / exp). The session bootstrap
// (fe-foundation session.ts) is unchanged; this is a SEPARATE, additive fetch
// that supplies the human display data the token deliberately omits — the
// caller's name + email, their role display names, and the tenant org label —
// for the shell's top-right user menu, the org-context label, and the rail
// footer.
//
// Loading-safe by construction: useMe() returns null until the fetch resolves
// and stays null on any error, so the chrome always renders (a neutral
// placeholder) and never blocks on /me.

import { useEffect, useState } from 'react';
import { apiClient } from '@aramo/fe-foundation';

export const ME_PATH = '/v1/me';

// Hand-mirror of libs/identity MeView (leaf consumer of the HTTP surface — the
// no-@aramo/* import rule, as in profile-api.ts).
export interface Me {
  readonly user: { readonly display_name: string | null; readonly email: string };
  readonly roles: readonly string[];
  // Inc-3 PR-3.5 (Workstream C) — `status` is the tenant lifecycle state; the
  // shell renders the OFFBOARDING winding-down banner from it.
  readonly tenant: { readonly display_name: string; readonly status: string };
}

export function fetchMe(): Promise<Me> {
  return apiClient.get<Me>(ME_PATH);
}

// Fetch /me once on mount, cache in component state. Null while in flight AND
// on error (loading-safe — the caller renders neutral chrome either way). No
// 401 special-casing: the shell only mounts inside an authenticated session, so
// a /me failure is a transient read error, not an auth signal (the session
// bootstrap owns auth state).
export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((value) => {
        if (!cancelled) setMe(value);
      })
      .catch(() => {
        // Loading-safe: leave `me` null; the chrome stays intact.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return me;
}
