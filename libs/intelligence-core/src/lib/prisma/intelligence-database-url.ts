// ADR-0036 Decision 2 — Talent Intelligence reads ONLY its own database URL.
// There is deliberately NO fallback to DATABASE_URL: a TI process that cannot
// find INTELLIGENCE_DATABASE_URL must refuse to start, never quietly attach to
// the shared Aramo database.

export const INTELLIGENCE_DATABASE_URL_ENV = 'INTELLIGENCE_DATABASE_URL';

export class IntelligenceDatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntelligenceDatabaseConfigError';
  }
}

/**
 * Resolve the TI connection string. Throws when it is unset/blank, or when it is
 * byte-identical to DATABASE_URL (TI must never share the ATS database).
 */
export function resolveIntelligenceDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env[INTELLIGENCE_DATABASE_URL_ENV]?.trim() ?? '';
  if (url.length === 0) {
    throw new IntelligenceDatabaseConfigError(
      `${INTELLIGENCE_DATABASE_URL_ENV} is not configured — the Talent Intelligence service has its own database (aramo_intelligence) and does not fall back to DATABASE_URL.`,
    );
  }
  const shared = env['DATABASE_URL']?.trim();
  if (shared !== undefined && shared.length > 0 && shared === url) {
    throw new IntelligenceDatabaseConfigError(
      `${INTELLIGENCE_DATABASE_URL_ENV} equals DATABASE_URL — Talent Intelligence must not use the shared Aramo database (ADR-0036 Decision 2).`,
    );
  }
  return url;
}
