import type { NestExpressApplication } from '@nestjs/platform-express';

/** D-PROXY-IP-1 / ADR-0023 PR-1: exactly one proxy hop (Caddy today, nginx
 *  after cutover). req.ip = proxy-observed client IP; budgets key per-client.
 *  Deliberately a constant, not env — see PR-1 directive Ruling 1.
 *  Duplicated verbatim in api / auth-service / platform-admin (Ruling 2). */
export const TRUST_PROXY_HOPS = 1;

export function applyTrustProxy(app: NestExpressApplication): void {
  app.set('trust proxy', TRUST_PROXY_HOPS);
}
