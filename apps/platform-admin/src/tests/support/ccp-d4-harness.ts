import { randomUUID } from 'node:crypto';

import { Global, Module, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import cookieParser from 'cookie-parser';
import { SignJWT, exportSPKI, generateKeyPair } from 'jose';
import { Client } from 'pg';
import request from 'supertest';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { REQUIRED_SCOPES_KEY } from '@aramo/authorization';
import {
  BILLING_PROVIDER_READ_PORT,
  COMMERCIAL_CLOCK,
  type BillingProviderReadPort,
  type ProviderInvoiceState,
  type ProviderPortalConfigurationState,
  type ProviderSubscriptionState,
} from '@aramo/subscription';

import { AppModule } from '../../app/app.module.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only real-Postgres support shared with the libs/subscription CCP specs (TD-A3-19 precedent; CLAUDE.md "one shared test helper")
import { PLATFORM_TENANT, addOperator, applyCcpA6Schema } from '../../../../../libs/subscription/src/tests/support/ccp-a3-database.js';

// CCP-D4 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.4 row D4) — ONE shared harness for the
// program-level D4 suites (CLAUDE.md: one shared test helper, not N duplicated edits).
//
// It boots the REAL platform-admin AppModule (as main.ts: cookie-parser, the global ValidationPipe)
// on a Postgres testcontainer holding identity + entitlement + metering + EVERY subscription
// migration (applyCcpA6Schema, the same chain the platform-admin Pact provider verifies against).
// There is NO resolver override: the real JwtAuthGuard resolves each principal's scopes from the
// seeded identity RBAC rows, the real RolesGuard and tier tripwire run, and the real services decide
// every refusal. Each principal is a real attested (D9) operator in the platform sentinel tenant.
//
// Two test seams only:
//   - COMMERCIAL_CLOCK (the services' @Optional clock token) from a @Global test module, so the
//     apply-deadline boundary can be placed to the millisecond; `null` = the wall clock.
//   - BILLING_PROVIDER_READ_PORT, an in-memory reader that records every provider ref it is asked
//     for (no Stripe, no network, no key), as the platform-admin Pact provider does.

export const CCP_ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor'] as const;
export type CcpRole = (typeof CCP_ROLES)[number];
export const ALL_ROLES = [...CCP_ROLES, 'super_admin'] as const;
export const CR = '/platform/commercial/change-requests';
export const CCP_PREFIX = '/platform/commercial';
export const INCLUDED = 'aramo-sign-included-v1';
export const BUSINESS = 'aramo-sign-standard-business-v1';

const AUTH_ISSUER = 'Aramo Core Auth';
const AUTH_AUDIENCE = 'aramo-ccp-d4-program-suite';

/** In-memory read port; `calls` records every provider ref read (tenant-isolation oracle). */
export class D4BillingReader implements BillingProviderReadPort {
  readonly provider = 'STRIPE' as const;
  readonly subs = new Map<string, ProviderSubscriptionState>();
  readonly invoices = new Map<string, ProviderInvoiceState[]>();
  readonly calls: string[] = [];
  isConfigured(): boolean {
    return true;
  }
  mode(): 'test' | 'live' {
    return 'test';
  }
  async retrieveSubscription(ref: string): Promise<ProviderSubscriptionState> {
    this.calls.push(`subscription:${ref}`);
    const s = this.subs.get(ref);
    if (s === undefined) throw new Error(`d4 reader: no subscription ${ref}`);
    return s;
  }
  async listSubscriptionInvoices(ref: string, limit: number): Promise<ProviderInvoiceState[]> {
    this.calls.push(`invoices:${ref}`);
    return (this.invoices.get(ref) ?? []).slice(0, limit);
  }
  async retrievePortalConfiguration(ref: string): Promise<ProviderPortalConfigurationState | null> {
    this.calls.push(`portal:${ref}`);
    return null;
  }
}

/** The service clock: `fixed` when set, else the wall clock. */
export const clock: { fixed: Date | null } = { fixed: null };

@Global()
@Module({ providers: [{ provide: COMMERCIAL_CLOCK, useValue: () => clock.fixed ?? new Date() }], exports: [COMMERCIAL_CLOCK] })
class D4ClockModule {}

// ── Route enumeration from the AppModule's controller metadata (as the A10 coverage gate) ────
type Ctor = abstract new (...args: never[]) => unknown;
function collectControllers(mod: unknown, seen = new Set<unknown>(), out: Ctor[] = []): Ctor[] {
  if (mod === undefined || mod === null || seen.has(mod)) return out;
  seen.add(mod);
  const ctrls = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, mod as object) ?? []) as Ctor[];
  out.push(...ctrls.filter((c) => !out.includes(c)));
  for (const child of (Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod as object) ?? []) as unknown[]) {
    collectControllers((child as { module?: unknown })?.module ?? child, seen, out);
  }
  return out;
}
const join = (...parts: string[]): string => '/' + parts.flatMap((p) => p.split('/')).filter((p) => p.length > 0).join('/');

export interface DeclaredRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** With `:param` placeholders, e.g. /platform/commercial/change-requests/:id/apply. */
  path: string;
  /** The @RequireScopes metadata, when present. */
  scopes: string[];
}

/** Every route the AppModule's controllers declare under `prefix`. */
export function declaredRoutes(prefix = CCP_PREFIX): DeclaredRoute[] {
  const routes: DeclaredRoute[] = [];
  for (const ctrl of collectControllers(AppModule)) {
    const base = String(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '');
    const proto = (ctrl as unknown as { prototype: Record<string, unknown> }).prototype;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      const sub = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
      const scopes = ((Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler) as string[] | undefined) ?? []).slice();
      routes.push({ method: RequestMethod[method] as DeclaredRoute['method'], path: join(base, sub), scopes });
    }
  }
  return routes.filter((r) => r.path.startsWith(prefix)).sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

/** Fill every `:param` with a fresh uuid. */
export const concrete = (path: string): string => path.replace(/:[A-Za-z_]+/g, () => randomUUID());

export interface D4Harness {
  pg: Client;
  url: string;
  app: NestExpressApplication;
  reader: D4BillingReader;
  /** alias → user id (one alias per role is created at boot: the role name). */
  user: Record<string, string>;
  /** Creates (and attests) an operator holding `roles` under `alias`. */
  operator(alias: string, roles: readonly string[], opts?: { attested?: boolean; human?: string }): Promise<string>;
  /** A bearer token for `alias` (platform tier) or a tenant-tier token for a recruiter. */
  token(alias: string, consumer?: 'platform' | 'recruiter', tenant_id?: string): Promise<string>;
  call(alias: string | null, method: string, path: string, body?: unknown, consumer?: 'platform' | 'recruiter'): Promise<request.Response>;
  post(alias: string, path: string, body?: unknown): Promise<request.Response>;
  get(alias: string, path: string): Promise<request.Response>;
  stop(): Promise<void>;
}

/** `[status, error.code, refusal | failure | reason]` — the comparable refusal triple. */
export const out = (res: request.Response): [number, string | null, string | null] => [
  res.status,
  res.body?.error?.code ?? null,
  res.body?.error?.details?.refusal ?? res.body?.error?.details?.failure ?? res.body?.error?.details?.reason ?? null,
];

export async function startD4(): Promise<D4Harness> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
  const url = container.getConnectionUri();
  const pg = new Client({ connectionString: url });
  await pg.connect();
  await applyCcpA6Schema(pg);
  const user: Record<string, string> = {};
  for (const role of ALL_ROLES) user[role] = await addOperator(pg, [role]);
  // A second distinct human per role a chain or a requester-only check needs (one role each).
  for (const role of ['finance_admin', 'platform_owner', 'commercial_ops', 'support_admin', 'catalog_manager']) user[`${role}_2`] = await addOperator(pg, [role]);

  const kp = await generateKeyPair('RS256');
  const savedEnv: Record<string, string | undefined> = {};
  const env: Record<string, string | undefined> = {
    // Generous Prisma pool / connect timeouts: the shared host runs many suites at once, and a
    // pool-acquire timeout surfaces as a fail-closed 401 (authz_unresolvable), not as a test result.
    DATABASE_URL: `${url}${url.includes('?') ? '&' : '?'}pool_timeout=60&connect_timeout=60`,
    AUTH_AUDIENCE,
    AUTH_PUBLIC_KEY: await exportSPKI(kp.publicKey),
    MAILER_PROVIDER: 'stub',
    REDIS_URL: undefined,
    SIGN_PERSONAL_SIGNUP_PURGE_ENABLED: '0',
    DOMAIN_CLAIM_SWEEP_ENABLED: undefined,
    SIGN_PERSONAL_LAPSE_SWEEP_ENABLED: undefined,
    CCP_USAGE_ROLLUP_ENABLED: undefined,
    STRIPE_PORTAL_CONFIGURATION: undefined,
    CCP_ALERTS_ENABLED: undefined,
  };
  for (const [k, v] of Object.entries(env)) {
    savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const reader = new D4BillingReader();
  const module: TestingModule = await Test.createTestingModule({ imports: [D4ClockModule, AppModule] }).overrideProvider(BILLING_PROVIDER_READ_PORT).useValue(reader).compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: ['error'] });
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();

  const recruiter = randomUUID();
  async function token(alias: string, consumer: 'platform' | 'recruiter' = 'platform', tenant_id = PLATFORM_TENANT): Promise<string> {
    const sub = consumer === 'recruiter' && user[alias] === undefined ? recruiter : (user[alias] as string);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub, actor_kind: 'user', consumer_type: consumer, tenant_id, authz_version: 1 })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(AUTH_ISSUER)
      .setAudience(AUTH_AUDIENCE)
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(kp.privateKey);
  }
  async function call(alias: string | null, method: string, path: string, body?: unknown, consumer: 'platform' | 'recruiter' = 'platform'): Promise<request.Response> {
    const agent = request(app.getHttpServer());
    const m = method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
    let req = agent[m](path);
    if (alias !== null) req = req.set('Authorization', `Bearer ${await token(alias, consumer, consumer === 'recruiter' ? randomUUID() : PLATFORM_TENANT)}`);
    req = req.timeout(60_000);
    try {
      return await (m === 'get' ? req : req.send((body ?? {}) as object));
    } catch (e) {
      // A request that never answers: name what the database is doing (lock waits) in the failure.
      const activity = await pg.query(
        `SELECT pid, state, wait_event_type, wait_event, now() - xact_start AS xact_age, left(query, 200) AS query FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'`,
      );
      const locks = await pg.query(`SELECT locktype, mode, granted, pid, relation::regclass::text AS rel, objid FROM pg_locks WHERE NOT granted`);
      throw new Error(`${method} ${path} as ${alias ?? 'anonymous'}: ${(e as Error).message}\nactivity=${JSON.stringify(activity.rows)}\nwaiting=${JSON.stringify(locks.rows)}`);
    }
  }
  return {
    pg,
    url,
    app,
    reader,
    user,
    async operator(alias, roles, opts = {}) {
      user[alias] = await addOperator(pg, roles, opts);
      return user[alias] as string;
    },
    token,
    call,
    post: (alias, path, body) => call(alias, 'POST', path, body),
    get: (alias, path) => call(alias, 'GET', path),
    async stop() {
      await app.close();
      await pg.end();
      await container.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}
