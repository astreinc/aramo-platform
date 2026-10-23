// @aramo/intelligence-core — Talent Intelligence persistence + domain core
// (ATI-SEP-1, ADR-0036). scope:intelligence: never imported by an ATS or
// Pipeline library; never imports one.
export { IntelligenceCoreModule } from './lib/intelligence-core.module.js';
export { IntelligenceHealthService } from './lib/intelligence-health.service.js';
export { IntelligencePrismaService } from './lib/prisma/intelligence-prisma.service.js';
export {
  INTELLIGENCE_DATABASE_URL_ENV,
  IntelligenceDatabaseConfigError,
  resolveIntelligenceDatabaseUrl,
} from './lib/prisma/intelligence-database-url.js';
