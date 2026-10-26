// Auth-Decoupling PR-4 (ADR-0021 §2 — auth defines the ports; Aramo implements
// the adapters). Auth's OWN principal-resolution port. Auth depends on NOTHING
// Aramo: this token + interface live in auth territory, and an Aramo adapter
// (IdentityPrincipalDirectoryAdapter) performs reconcile-by-email, sub-linking,
// membership activation, tenant selection, status gating, site stamping, and
// scope resolution behind ONE generic call (R-P4-1 — FAT ADAPTER, GENERIC PORT).
//
// Auth asks "resolve this verified identity into a session context" and "resolve
// this known principal's scopes in a context" — it does NOT know what a tenant, a
// site, a SUSPENDED status, or a fingerprint is. `consumer` is passed TO the port;
// the ADAPTER decides the platform-sentinel status-gate exemption (computing that
// flag auth-side would leak the policy back into auth).

import type { HostBindingClass } from './host-binding.js';

export interface ResolveSessionInput {
  provider: string;
  provider_subject: string;
  // The IdP-VERIFIED email (the adapter normalises it for reconcile-by-email).
  verified_email: string;
  consumer: 'recruiter' | 'portal' | 'ingestion' | 'platform' | 'sign' | 'org';
  // IC-2 PR-4 (Auth-Decoupling PR-4 Amendment A1 §2 item 4) — OPTIONAL host
  // classification + host context sealed at login. Auth passes them through;
  // the ADAPTER applies the binding rules (host-binding.ts) after tenant
  // selection and before the status gate. undefined = unbound (legacy cookie).
  host_class?: HostBindingClass | null;
  context_id?: string | null;
  // AUTH-SIGNIN-1 R1 — the federated provider that authenticated the token
  // ('google' | 'microsoft' | 'ambiguous' | null). The adapter applies the
  // provider policy (no cross-provider merge; the enforced-pin cohort).
  idp?: string | null;
  // AUTH-SIGNIN-1 Amendment M-A1 §3.7 — the client kind. 'native' (the Aramo Sign
  // mobile exchange) is NOT passed through browser host binding and no browser
  // Host is simulated: the adapter skips the host-binding step for it and applies
  // every other rule (reconcile, no JIT, provider policy R1/R2, IC-1, status,
  // capability) unchanged. undefined = browser (today's behaviour).
  client?: 'native';
}

// `principal_id` / `context_id` are opaque to auth (they happen to be a user id and
// a tenant id). `claims` carries optional session claims — today just `site_id`
// when a site-scoped membership stamps one.
// IC-2 PR-4 (Amendment A1 §2 item 1) — the union is `resolved | denied`. A
// defensive multi-tenant resolution (unreachable against the IC-1 PR-3 database)
// is `denied` with reason `tenant_resolution_ambiguous`; there is no chooser.
export type ResolveSessionResult =
  | {
      kind: 'resolved';
      principal_id: string;
      context_id: string;
      // Server-side effective scopes (used for the /session response body, NOT the
      // token). HF-AUTH-1 — the compact access token carries `authz_version`, not
      // this list.
      scopes: string[];
      // HF-AUTH-1 — the principal's current authorization revision, stamped into
      // the compact token at mint.
      authz_version: number;
      claims?: Record<string, string>;
    }
  | { kind: 'denied'; reason: string };

export interface ResolveScopesInput {
  principal_id: string;
  context_id: string;
  // IC-2 PR-5 (Auth-Decoupling PR-4 Amendment A2) — OPTIONAL consumer so the
  // adapter applies the same platform-sentinel status-gate exemption at refresh
  // that it applies at login. undefined = tenant consumer (gate applies).
  consumer?: 'recruiter' | 'portal' | 'ingestion' | 'platform' | 'sign' | 'org';
}

// The re-mint path (refresh): re-resolve a known principal's authz_version + site
// claim in a context, reusing the SAME site-stamp logic resolveSession performs.
// `scopes` remains for server-side use (e.g. any response body); the re-minted
// compact token carries `authz_version`, not scopes.
// IC-2 PR-5 (Amendment A2): the result is `resolved | denied` — the adapter
// re-proves ELIGIBILITY (User active, active membership in the context, tenant
// not SUSPENDED/CLOSED for tenant consumers) before a session is re-minted;
// `denied` reasons: user_inactive · membership_inactive · tenant_suspended ·
// tenant_closed. Auth never trusts the stored token's tenant on its own.
export type ResolveScopesResult =
  | {
      kind: 'resolved';
      scopes: string[];
      authz_version: number;
      claims?: Record<string, string>;
    }
  | { kind: 'denied'; reason: string };

export const PRINCIPAL_DIRECTORY = 'PRINCIPAL_DIRECTORY';

export interface PrincipalDirectory {
  resolveSession(input: ResolveSessionInput): Promise<ResolveSessionResult>;
  resolveScopes(input: ResolveScopesInput): Promise<ResolveScopesResult>;
}
