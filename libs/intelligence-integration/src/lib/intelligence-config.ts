// ATI-SEP-1 T8 (ADR-0036 §3) — the ATS-side Talent Intelligence configuration.
//
// EVERY variable is OPTIONAL (directive invariant: the ATS works with TI absent).
// When the URL or the client credentials are unset, the integration is
// NOT CONFIGURED: the publisher acknowledges every event with outcome
// TI_NOT_CONFIGURED, the entitlement sync and inbound sync are no-ops, and the
// portal verification route reports the feature as unavailable. Nothing here is
// read on an ATS create / update request path.
//
//   INTELLIGENCE_SERVICE_URL                 TI origin (compose: http://talent-intelligence-service:3004)
//   INTELLIGENCE_ATS_CLIENT_ID               client_credentials id  (provisioned in TI)
//   INTELLIGENCE_ATS_CLIENT_SECRET           client_credentials secret
//   INTELLIGENCE_WEBHOOK_SIGNING_SECRET      verifies TI → ATS webhooks (same value as TI's)
//   INTELLIGENCE_VERIFICATION_ENABLED        'true' routes portal identifier verification to TI (default false)
//   INTELLIGENCE_HTTP_TIMEOUT_MS             per-call timeout (default 5000)
//   INTELLIGENCE_ENTITLEMENT_SYNC_INTERVAL_MS full REPLACE entitlement sync period (default 900000; 0 disables)
//   INTELLIGENCE_INBOUND_SYNC_INTERVAL_MS    inbound inbox drain period (default 5000; 0 disables)

export const INTELLIGENCE_SERVICE_URL_ENV = 'INTELLIGENCE_SERVICE_URL';
export const INTELLIGENCE_ATS_CLIENT_ID_ENV = 'INTELLIGENCE_ATS_CLIENT_ID';
export const INTELLIGENCE_ATS_CLIENT_SECRET_ENV = 'INTELLIGENCE_ATS_CLIENT_SECRET';
export const INTELLIGENCE_VERIFICATION_ENABLED_ENV = 'INTELLIGENCE_VERIFICATION_ENABLED';
export const INTELLIGENCE_HTTP_TIMEOUT_MS_ENV = 'INTELLIGENCE_HTTP_TIMEOUT_MS';
export const INTELLIGENCE_ENTITLEMENT_SYNC_INTERVAL_MS_ENV = 'INTELLIGENCE_ENTITLEMENT_SYNC_INTERVAL_MS';
export const INTELLIGENCE_INBOUND_SYNC_INTERVAL_MS_ENV = 'INTELLIGENCE_INBOUND_SYNC_INTERVAL_MS';

export const DEFAULT_INTELLIGENCE_HTTP_TIMEOUT_MS = 5000;
export const DEFAULT_ENTITLEMENT_SYNC_INTERVAL_MS = 900_000;
export const DEFAULT_INBOUND_SYNC_INTERVAL_MS = 5000;

export interface IntelligenceIntegrationConfig {
  readonly serviceUrl: string | null;
  readonly clientId: string | null;
  readonly clientSecret: string | null;
  /** URL + client id + client secret all present. */
  readonly configured: boolean;
  readonly timeoutMs: number;
  readonly verificationEnabled: boolean;
  /** 0 = periodic sync disabled. */
  readonly entitlementSyncIntervalMs: number;
  /** 0 = inbound drain disabled. */
  readonly inboundSyncIntervalMs: number;
}

function nonEmpty(v: string | undefined): string | null {
  const t = v?.trim() ?? '';
  return t.length > 0 ? t : null;
}

function nonNegativeInt(v: string | undefined, fallback: number, min = 0): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n === 0) return 0;
  return Math.max(min, Math.floor(n));
}

export function loadIntelligenceConfig(env: NodeJS.ProcessEnv = process.env): IntelligenceIntegrationConfig {
  const rawUrl = nonEmpty(env[INTELLIGENCE_SERVICE_URL_ENV]);
  const serviceUrl = rawUrl !== null && /^https?:\/\/[^\s/]+/i.test(rawUrl) ? rawUrl.replace(/\/+$/, '') : null;
  const clientId = nonEmpty(env[INTELLIGENCE_ATS_CLIENT_ID_ENV]);
  const clientSecret = nonEmpty(env[INTELLIGENCE_ATS_CLIENT_SECRET_ENV]);
  const timeout = nonNegativeInt(env[INTELLIGENCE_HTTP_TIMEOUT_MS_ENV], DEFAULT_INTELLIGENCE_HTTP_TIMEOUT_MS, 250);
  return {
    serviceUrl,
    clientId,
    clientSecret,
    configured: serviceUrl !== null && clientId !== null && clientSecret !== null,
    timeoutMs: timeout === 0 ? DEFAULT_INTELLIGENCE_HTTP_TIMEOUT_MS : timeout,
    verificationEnabled: (env[INTELLIGENCE_VERIFICATION_ENABLED_ENV] ?? '').trim().toLowerCase() === 'true',
    entitlementSyncIntervalMs: nonNegativeInt(env[INTELLIGENCE_ENTITLEMENT_SYNC_INTERVAL_MS_ENV], DEFAULT_ENTITLEMENT_SYNC_INTERVAL_MS, 10_000),
    inboundSyncIntervalMs: nonNegativeInt(env[INTELLIGENCE_INBOUND_SYNC_INTERVAL_MS_ENV], DEFAULT_INBOUND_SYNC_INTERVAL_MS, 250),
  };
}

/** DI token for the resolved config (a factory over loadIntelligenceConfig by default). */
export const INTELLIGENCE_INTEGRATION_CONFIG = 'INTELLIGENCE_INTEGRATION_CONFIG';
