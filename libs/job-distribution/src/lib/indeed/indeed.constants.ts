// SRC-2 PR-3 — Indeed Job Sync connector constants. Grounded verbatim in the
// PRE-BUILD RECON against Indeed's Job Sync partner docs (docs.indeed.com):
//   RECON-1 — GraphQL endpoint https://apis.indeed.com/graphql; mutations
//             jobsIngest.createSourcedJobPostings (create+update UPSERT) and
//             jobsIngest.expireSourcedJobsBySourcedPostingId.
//   RECON-2 — OAuth token endpoint https://apis.indeed.com/oauth/v2/tokens,
//             grant_type=client_credentials, scope=employer_access, 3600s TTL.
// No @aramo import — the lib stays buildable-import-free.

// R7 / DEV-C — the partner OAuth app credentials (platform-level, R5: one app for
// all tenants; NEVER per-tenant-config). Unset → the connector is disabled and the
// sweep skips every tick (fail-closed), no crash-loop.
export const INDEED_CLIENT_ID_ENV = 'ARAMO_INDEED_CLIENT_ID';
export const INDEED_CLIENT_SECRET_ENV = 'ARAMO_INDEED_CLIENT_SECRET';

// DEV-C — OAuth scope, env-overridable. RECON-2 grounded only `employer_access`;
// no distinct job-ingestion scope surfaced. Overridable so certification can set a
// different scope without a code change.
export const INDEED_OAUTH_SCOPE_ENV = 'ARAMO_INDEED_OAUTH_SCOPE';
export const INDEED_OAUTH_SCOPE_DEFAULT = 'employer_access';

// DEV-C — GraphQL base URL, env-overridable, defaulting to the RECON-1 prod
// endpoint. Certification points this at the "simulated GraphQL environment"
// without a code change. The OAuth token endpoint is a fixed module constant
// below: the simulated environment uses real OAuth (real credentials → a token)
// then the simulated GraphQL URL, so only the GraphQL base needs to move.
export const INDEED_GRAPHQL_BASE_ENV = 'ARAMO_INDEED_GRAPHQL_BASE';
export const INDEED_GRAPHQL_BASE_DEFAULT = 'https://apis.indeed.com/graphql';

// RECON-2 — the 2-legged (client-credentials) token endpoint. Fixed (see above).
export const INDEED_OAUTH_TOKEN_URL = 'https://apis.indeed.com/oauth/v2/tokens';
export const INDEED_OAUTH_GRANT_TYPE = 'client_credentials';

// RECON-2 — tokens expire in 3600s; refresh hourly. We refresh EARLY by this skew
// so an in-flight mutation never rides an about-to-expire token.
export const INDEED_TOKEN_REFRESH_SKEW_SECONDS = 60;

// The storage-key channel segment (lowercase) — matches SRC-1's INDEED_STORAGE_CHANNEL.
export const INDEED_CHANNEL = 'indeed';

// RECON-1 — the Indeed Apply webhook postUrl path (SRC-1 PR-2's mount point). A
// posted job carries this (per tenant host) so applications flow back into the
// dark webhook. Kept in sync with apps/api INDEED_APPLY_WEBHOOK_ROUTE.
export const INDEED_APPLY_WEBHOOK_PATH = '/v1/webhooks/indeed/apply';

// DEV-D (period fidelity) — our RatePeriod enum → Indeed's salary `period` string.
// RECON-1 verbatim-confirmed only "HOUR" (the create-example-job fixture); the
// rest are a best-effort mapping flagged as a PR-4 certification item (the exact
// Indeed period vocabulary is verified against the live schema at cert). An
// unmapped period is omitted from the payload rather than guessed.
export const RATE_PERIOD_TO_INDEED: Readonly<Record<string, string>> = {
  HOURLY: 'HOUR',
  DAILY: 'DAY',
  WEEKLY: 'WEEK',
  MONTHLY: 'MONTH',
  ANNUAL: 'YEAR',
};
