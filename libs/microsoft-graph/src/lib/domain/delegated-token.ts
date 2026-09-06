// COMM-C2B — delegated token bundle (directive R3/R4/R18).
//
// Token material (access + refresh) lives ONLY in the governed secret store and
// server memory during use. This module models the bundle and — critically —
// provides the redaction used everywhere a token could otherwise leak (logs,
// audit, analytics, exception text, read APIs). The redacted form carries only
// non-secret lifecycle/identity metadata.

export interface DelegatedTokenBundle {
  readonly access_token: string;
  readonly refresh_token: string;
  /** Absolute expiry, epoch seconds. */
  readonly expires_at: number;
  readonly token_type: string;
  /** The scopes Microsoft actually granted (space-delimited). */
  readonly scope: string;
  /** Microsoft tenant id (`tid` claim) — part of the R6 identity binding. */
  readonly ms_tenant_id: string;
  /** Microsoft user/object id (`oid`/`sub` claim) — part of the R6 identity binding. */
  readonly ms_object_id: string;
}

/** Non-secret, log/audit-safe projection of a token bundle (R3/R18). */
export interface RedactedTokenMetadata {
  readonly expires_at: number;
  readonly scope: string;
  readonly ms_tenant_id: string;
  readonly ms_object_id: string;
  readonly has_refresh_token: boolean;
}

/**
 * Reduce a bundle to its non-secret metadata. The ONLY representation of a token
 * bundle permitted in logs, audit records, analytics, or read APIs (R3).
 */
export function redactTokenBundle(bundle: DelegatedTokenBundle): RedactedTokenMetadata {
  return {
    expires_at: bundle.expires_at,
    scope: bundle.scope,
    ms_tenant_id: bundle.ms_tenant_id,
    ms_object_id: bundle.ms_object_id,
    has_refresh_token: bundle.refresh_token.length > 0,
  };
}

/** Skew (seconds) applied when deciding whether an access token needs refresh. */
export const TOKEN_REFRESH_SKEW_SECONDS = 120;

/** Whether the access token is expired/near-expiry and must be refreshed (R4). */
export function tokenNeedsRefresh(bundle: DelegatedTokenBundle, nowEpochSeconds: number): boolean {
  return bundle.expires_at - TOKEN_REFRESH_SKEW_SECONDS <= nowEpochSeconds;
}

/**
 * Defensive R3 guard for tests/audit builders: assert an object (about to be
 * logged/persisted/returned) carries NO token material. Throws if an
 * `access_token`/`refresh_token` key with a non-empty value is present anywhere.
 */
export function assertNoTokenMaterial(subject: unknown): void {
  const seen = new Set<unknown>();
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object') {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if ((key === 'access_token' || key === 'refresh_token') && typeof v === 'string' && v.length > 0) {
        throw new Error(`token material leaked via '${key}' (R3)`);
      }
      walk(v);
    }
  };
  walk(subject);
}
