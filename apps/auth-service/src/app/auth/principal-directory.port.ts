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

export interface ResolveSessionInput {
  provider: string;
  provider_subject: string;
  // The IdP-VERIFIED email (the adapter normalises it for reconcile-by-email).
  verified_email: string;
  consumer: 'recruiter' | 'portal' | 'ingestion' | 'platform';
}

// `principal_id` / `context_id` are opaque to auth (they happen to be a user id and
// a tenant id). `claims` carries optional session claims — today just `site_id`
// when a site-scoped membership stamps one.
export type ResolveSessionResult =
  | {
      kind: 'resolved';
      principal_id: string;
      context_id: string;
      scopes: string[];
      claims?: Record<string, string>;
    }
  | { kind: 'ambiguous'; choices: { id: string; name: string }[] }
  | { kind: 'denied'; reason: string };

export interface ResolveScopesInput {
  principal_id: string;
  context_id: string;
}

// The re-mint path (refresh): re-resolve a known principal's scopes + site claim
// in a context, reusing the SAME site-stamp logic resolveSession performs.
export interface ResolveScopesResult {
  scopes: string[];
  claims?: Record<string, string>;
}

export const PRINCIPAL_DIRECTORY = 'PRINCIPAL_DIRECTORY';

export interface PrincipalDirectory {
  resolveSession(input: ResolveSessionInput): Promise<ResolveSessionResult>;
  resolveScopes(input: ResolveScopesInput): Promise<ResolveScopesResult>;
}
