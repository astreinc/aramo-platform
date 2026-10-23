// ATI-SEP-1 — the CLIENT-ONLY entry of @aramo/intelligence-integration: the
// HTTP client, its typed errors and its config type, with NO Nest module,
// repository or Prisma-backed service behind it. Contract tests (the
// intelligence-integration Pact consumer) resolve the package here so they
// load no database code and need no generated Prisma clients.
export {
  IntelligenceClient,
  IntelligenceNotConfiguredError,
  IntelligenceRejectedError,
  IntelligenceUnavailableError,
  type IntelligenceFetch,
} from './lib/intelligence-client.js';
export type { IntelligenceIntegrationConfig } from './lib/intelligence-config.js';
