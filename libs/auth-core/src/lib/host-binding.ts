import { PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import type { HostClass } from '@aramo/auth-storage';

// IC-2 PR-4 — Session tenant binding (IC-0 §F.2 rule 1; Auth-Decoupling PR-4
// Amendment A1 §2 items 4-5; Subdomain-B Amendment A1 §2). The PURE policy that
// decides whether the identity resolved at the callback may be bound to the host
// class + host context sealed into the PKCE state at login. Auth-core owns the
// policy text; the Aramo principal adapter applies it after tenant selection and
// before the status gate (F-5), and the orchestrator applies it to the login vs
// callback host agreement. No I/O here; the env readers are the only process
// access and are read per call (never at module load) so tests and operators can
// flip them.
//
// Modes (F-6): AUTH_HOST_TENANT_BINDING = 'log' (default) | 'enforce'.
//   log     — the outcome is UNCHANGED; a structured diagnostic is recorded.
//   enforce — a mismatched, missing or unbound host context is DENIED; no
//             session is minted. AUTH_ALLOW_UNBOUND_HOST=true is the explicit
//             dev exception that lets a dev/unvalidated host mint under enforce.
//             No flag overrides an explicit tenant or platform mismatch.
//
// Reasons (closed set; mapped by the controller to the EXISTING 403
// TENANT_ACCESS_DENIED, naming no foreign tenant):
//   host_tenant_mismatch          — TENANT host context ≠ resolved tenant, or a
//                                   PLATFORM host resolved a non-sentinel tenant
//   host_class_consumer_mismatch  — the consumer cannot be served on that host
//                                   class (PLATFORM needs `platform`; PORTAL is
//                                   the passwordless path only; PRODUCT is DARK)
//   host_unbound                  — no sealed/validated host context (a legacy
//                                   PKCE cookie, F-8; an unvalidated host; a dev
//                                   host) and AUTH_ALLOW_UNBOUND_HOST is not true

export type HostBindingClass = HostClass | 'DEV';
export type HostBindingMode = 'log' | 'enforce';
export type HostBindingReason =
  | 'host_tenant_mismatch'
  | 'host_class_consumer_mismatch'
  | 'host_unbound';

export const HOST_BINDING_MODE_ENV = 'AUTH_HOST_TENANT_BINDING';
export const ALLOW_UNBOUND_HOST_ENV = 'AUTH_ALLOW_UNBOUND_HOST';

type Env = Record<string, string | undefined>;

// Fail-closed parse: ONLY the exact literal 'enforce' enforces; anything else
// (unset, empty, a typo) is the default log posture.
export function readHostBindingMode(env: Env = process.env): HostBindingMode {
  return env[HOST_BINDING_MODE_ENV] === 'enforce' ? 'enforce' : 'log';
}

export function allowUnboundHost(env: Env = process.env): boolean {
  return env[ALLOW_UNBOUND_HOST_ENV] === 'true';
}

export interface HostBindingInput {
  // The host class sealed at login (undefined/null = unbound / legacy cookie).
  host_class: HostBindingClass | null | undefined;
  // The host context sealed at login (the tenant id for a TENANT host).
  context_id: string | null | undefined;
  consumer: string;
  // The tenant the principal resolution selected (selectedTenant.id — F-2).
  resolved_context_id: string;
  // Defaults to PLATFORM_TENANT_SENTINEL_ID (auth-core already depends on
  // @aramo/auth; the adapter needs no new edge).
  platform_sentinel_id?: string;
  allow_unbound: boolean;
}

export type HostBindingVerdict =
  | { ok: true; bound: boolean }
  | { ok: false; reason: HostBindingReason };

export function evaluateHostBinding(input: HostBindingInput): HostBindingVerdict {
  const hostClass = input.host_class ?? null;
  if (hostClass === null || hostClass === 'DEV') {
    return input.allow_unbound
      ? { ok: true, bound: false }
      : { ok: false, reason: 'host_unbound' };
  }
  switch (hostClass) {
    case 'TENANT': {
      const sealed = input.context_id ?? null;
      return sealed !== null && sealed === input.resolved_context_id
        ? { ok: true, bound: true }
        : { ok: false, reason: 'host_tenant_mismatch' };
    }
    case 'PLATFORM': {
      if (input.consumer !== 'platform') {
        return { ok: false, reason: 'host_class_consumer_mismatch' };
      }
      return input.resolved_context_id === (input.platform_sentinel_id ?? PLATFORM_TENANT_SENTINEL_ID)
        ? { ok: true, bound: true }
        : { ok: false, reason: 'host_tenant_mismatch' };
    }
    case 'PORTAL':
    case 'PRODUCT':
      // PORTAL: the Cognito callback never serves the portal host (passwordless
      // path only). PRODUCT: DARK scaffold (F-3/F-5) — not operational for login.
      return { ok: false, reason: 'host_class_consumer_mismatch' };
  }
}

// IC-2 PR-5 — the SESSION-SURFACE binding (/session, /refresh, /logout): the
// SAME rules as the callback binding above, with ONE additive clause the
// callback never needs: a `portal` consumer is served ONLY on the PORTAL host
// class (its sessions carry the platform sentinel as tenant_id, so the tenant
// comparison does not apply), and a PORTAL host serves ONLY the portal
// consumer. PRODUCT stays DARK (refused). Everything else delegates to
// evaluateHostBinding — the PR-4 policy is not rewritten.
export function evaluateSessionHostBinding(input: HostBindingInput): HostBindingVerdict {
  const hostClass = input.host_class ?? null;
  if (input.consumer === 'portal') {
    if (hostClass === null || hostClass === 'DEV') {
      return input.allow_unbound
        ? { ok: true, bound: false }
        : { ok: false, reason: 'host_unbound' };
    }
    return hostClass === 'PORTAL' &&
      input.resolved_context_id === (input.platform_sentinel_id ?? PLATFORM_TENANT_SENTINEL_ID)
      ? { ok: true, bound: true }
      : { ok: false, reason: 'host_class_consumer_mismatch' };
  }
  return evaluateHostBinding(input);
}

// The closed set of denial reasons the controller maps to 403 TENANT_ACCESS_DENIED
// (existing code; F-5). Shared so the controller and the adapter cannot drift.
export const TENANT_ACCESS_DENIED_REASONS: ReadonlySet<string> = new Set([
  'no_active_tenant',
  'tenant_resolution_ambiguous',
  'host_tenant_mismatch',
  'host_class_consumer_mismatch',
  'host_unbound',
  // AUTH-SIGNIN-1 R1/R2 — wrong provider for an enforced-pin tenant, or a
  // second provider for the same person; the wrong-account recovery applies.
  'idp_not_permitted_for_tenant',
  'idp_identity_conflict',
]);

// IC-2 PR-5 — refresh eligibility denial reasons (adapter.resolveScopes). Each
// is a 401 REFRESH_TOKEN_INVALID on the refresh path (cookies cleared) and the
// presented refresh token is REVOKED so a retained copy cannot resume the
// session once eligibility is restored without re-authenticating.
export const REFRESH_ELIGIBILITY_REASONS: ReadonlySet<string> = new Set([
  'user_inactive',
  'membership_inactive',
  'tenant_suspended',
  'tenant_closed',
  // IC-2 PR-6 — the consumer's product capability is not entitled / the consumer
  // is not supported on the Cognito mint path.
  'consumer_not_entitled',
  'consumer_not_supported',
]);
