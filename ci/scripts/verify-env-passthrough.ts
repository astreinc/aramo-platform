// GLH-1 (ATS Go-Live Hardening Charter v1.5) D — production env-passthrough parity wall.
//
// The prod stack (docker-compose.prod.yml) reads secrets/config from the SHELL env: a
// bare-name `environment:` entry (`- FOO`) is PASSED THROUGH from the sourced `.env`, and a
// `${FOO}` interpolation WITHOUT a `:-default` REQUIRES that shell var to exist. Two silent
// failure modes (the D-AUTH-PLATFORM-HOSTS-1 defect class, self-documented at
// docker-compose.prod.yml:191-195):
//   (1) a var a container REQUIRES is dropped from that service's passthrough → the
//       container boots without it (crash-loop, or silently degraded/dark);
//   (2) a var the compose passes through is absent from the operator contract
//       (.env.prod.example) → the operator never sets it → it arrives empty.
//
// This wall enforces, from the two config files ONLY (no whole-repo process.env scan, per
// the GLH-1 §7 ownership rule):
//   ASSERTION 1 — every var in the per-service REQUIRED manifest (below) is a passthrough of
//                 that service. The manifest is the "fails LOUD if unset" set the compose +
//                 .env.prod.example comments already declare — the actual runtime-ownership
//                 rule, NOT every env var.
//   ASSERTION 2 — every var the compose passes through (bare-name, anchor-resolved) or
//                 requires via a no-default `${VAR}` interpolation is DOCUMENTED in
//                 .env.prod.example (incl. commented `# VAR=` optional entries).
//
// Optional (`${VAR:-default}`) interpolations, literal assignments, and build/deploy image
// overrides are NOT required — the wall never fails on them (§7: distinguish required from
// optional/build-time/host-only). YAML anchors/aliases are resolved by the parser, so the
// single-sourced `&identity_pepper ARAMO_IDENTITY_PEPPER` / `*identity_pepper` entries are
// seen on BOTH api and auth-service.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';

const ROOT = resolve(__dirname, '..', '..');
const COMPOSE = resolve(ROOT, 'docker-compose.prod.yml');
const ENV_EXAMPLE = resolve(ROOT, '.env.prod.example');

// Per-service REQUIRED runtime passthroughs — the vars whose absence breaks the container
// ("REQUIRED — fails LOUD if unset" per docker-compose.prod.yml / .env.prod.example). This
// is the runtime-ownership rule; adding a new fail-loud var here forces it into the compose
// passthrough AND (via assertion 2) the operator contract.
export const REQUIRED_PASSTHROUGH: Record<string, string[]> = {
  api: [
    'ARAMO_IDENTITY_PEPPER', // loadIdentityPepper fails loud (canonicalization stops)
    'ARAMO_IDENTITY_ADMISSION_POLICY', // loadIdentityAdmissionPolicy fails loud on the mint path
    'DNS_PROVIDER', // loadDnsConfig fails loud (api crash-loops)
    'MAILER_PROVIDER', // no default → fails loud at module binding
    // E-Sign production wiring (Aramo-E-Sign-Production-Service-URL-Wiring-Authorization-v1_0)
    // — failure mode (1) "silently degraded/dark": without these the api boots but every
    // E-Sign call targets its own localhost / every sign-service request is refused.
    'SIGN_SERVICE_URL', // api → sign-service origin (http://sign-service:3003)
    'SIGN_WEBHOOK_SIGNING_SECRET', // verifies the webhook + ES-2 source requests
  ],
  'sign-service': [
    'DOCUMENTS_API_URL', // sign-service → api origin (http://api:3000): source pull + webhook
    'SIGN_WEBHOOK_SIGNING_SECRET', // signs the webhook + ES-2 source requests (same value as api)
    'SIGN_WEB_BASE_URL', // signer link base (https://sign.aramo.ai); unset ⇒ no invitation sent
    // SES credentials — without them the SDK uses the Lightsail instance role (no ses:SendEmail)
    // and every signer invitation/reminder is dropped.
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
  ],
  'auth-service': [
    'ARAMO_IDENTITY_PEPPER', // shared pepper (Portal P1 eligibility fingerprint) — must match api
    'MAILER_PROVIDER', // portal login mail rides the SES mailer path
  ],
};

// Per-service REQUIRED guarded interpolations — vars a service consumes INSIDE a built value
// (e.g. a URL assembled from parts) behind a `${VAR:?message}` guard, so compose refuses to
// start without them. ATI-SEP-1 T0: talent-intelligence-service builds
// INTELLIGENCE_DATABASE_URL from INTELLIGENCE_DB_PASSWORD; dropping the guard would boot the
// service against an empty password. ASSERTION 1b keeps the guard; ASSERTION 2b documents
// every guarded var (incl. POSTGRES_PASSWORD) in the operator contract.
export const REQUIRED_GUARDED: Record<string, string[]> = {
  'talent-intelligence-service': ['INTELLIGENCE_DB_PASSWORD'],
};

export interface ComposeEnvModel {
  /** service id -> bare-name passthrough vars (anchor-resolved) */
  passthroughByService: Record<string, string[]>;
  /** every bare-name passthrough var across all services */
  allPassthrough: Set<string>;
  /** vars required via a no-default `${VAR}` interpolation anywhere in the file */
  requiredInterpolations: Set<string>;
  /** service id -> vars referenced behind a `${VAR:?message}` guard in its environment */
  guardedByService: Record<string, string[]>;
  /** every `${VAR:?message}` guarded var anywhere in the file */
  requiredGuards: Set<string>;
}

/** Extract passthrough + required-interpolation vars from a compose document + its raw text. */
export function parseComposeEnv(composeText: string): ComposeEnvModel {
  const doc = parse(composeText) as {
    services?: Record<string, { environment?: unknown }>;
  };
  const services = doc.services ?? {};
  const passthroughByService: Record<string, string[]> = {};
  const allPassthrough = new Set<string>();
  const guardedByService: Record<string, string[]> = {};

  for (const [svc, def] of Object.entries(services)) {
    const env = def?.environment;
    const bare: string[] = [];
    if (Array.isArray(env)) {
      for (const raw of env) {
        const entry = String(raw);
        // Bare-name passthrough = a list entry with NO '=' (value comes from the shell env).
        if (!entry.includes('=')) bare.push(entry.trim());
      }
    }
    // Map-form environment (e.g. postgres) is always assigned key: value — never a
    // bare-name passthrough — so it contributes nothing here.
    if (bare.length) {
      passthroughByService[svc] = bare;
      for (const v of bare) allPassthrough.add(v);
    }
    const entries = Array.isArray(env)
      ? env.map(String)
      : Object.values((env ?? {}) as Record<string, unknown>).map(String);
    const guarded = new Set<string>();
    for (const entry of entries) {
      for (const g of entry.matchAll(/\$\{([A-Z_][A-Z0-9_]*):\?/g)) guarded.add(g[1]);
    }
    if (guarded.size) guardedByService[svc] = [...guarded];
  }

  // No-default interpolations `${VAR}` (a `${VAR:-...}` / `${VAR:?...}` has a default/guard
  // and is therefore optional). Scanned from raw text — interpolations are literal.
  const requiredInterpolations = new Set<string>();
  const noDefault = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = noDefault.exec(composeText)) !== null) requiredInterpolations.add(m[1]);

  const requiredGuards = new Set<string>();
  for (const g of composeText.matchAll(/\$\{([A-Z_][A-Z0-9_]*):\?/g)) requiredGuards.add(g[1]);

  return { passthroughByService, allPassthrough, requiredInterpolations, guardedByService, requiredGuards };
}

/** Keys documented in .env.prod.example (incl. commented `# VAR=` optional entries). */
export function documentedKeys(envExampleText: string): Set<string> {
  const keys = new Set<string>();
  const re = /^\s*#?\s*([A-Z_][A-Z0-9_]*)=/;
  for (const line of envExampleText.split('\n')) {
    const mm = re.exec(line);
    if (mm) keys.add(mm[1]);
  }
  return keys;
}

export interface EnvViolation {
  kind:
    | 'required-not-passed-through'
    | 'passthrough-not-documented'
    | 'required-interp-not-documented'
    | 'required-guard-missing'
    | 'guarded-not-documented';
  var: string;
  service?: string;
}

export function validateEnvPassthrough(
  model: ComposeEnvModel,
  documented: Set<string>,
  requiredManifest: Record<string, string[]> = REQUIRED_PASSTHROUGH,
  guardedManifest: Record<string, string[]> = REQUIRED_GUARDED,
): EnvViolation[] {
  const violations: EnvViolation[] = [];

  // ASSERTION 1 — every manifest-required var is a passthrough of its service.
  for (const [svc, vars] of Object.entries(requiredManifest)) {
    const have = new Set(model.passthroughByService[svc] ?? []);
    for (const v of vars) {
      if (!have.has(v))
        violations.push({ kind: 'required-not-passed-through', var: v, service: svc });
    }
  }

  // ASSERTION 1b — every manifest-guarded var is `${VAR:?}`-guarded in its service.
  for (const [svc, vars] of Object.entries(guardedManifest)) {
    const have = new Set(model.guardedByService[svc] ?? []);
    for (const v of vars) {
      if (!have.has(v)) violations.push({ kind: 'required-guard-missing', var: v, service: svc });
    }
  }

  // ASSERTION 2 — every passthrough var is documented in the operator contract.
  for (const v of model.allPassthrough) {
    if (!documented.has(v)) violations.push({ kind: 'passthrough-not-documented', var: v });
  }
  // ... and every no-default interpolation var is documented too.
  for (const v of model.requiredInterpolations) {
    if (!documented.has(v)) violations.push({ kind: 'required-interp-not-documented', var: v });
  }
  // ASSERTION 2b — and every `${VAR:?}`-guarded var (the compose refuses to start without it).
  for (const v of model.requiredGuards) {
    if (!documented.has(v)) violations.push({ kind: 'guarded-not-documented', var: v });
  }

  return violations;
}

// ASSERTION 3 — local-development settings never reach production. These are read
// by code only to make a laptop stack usable (local mailbox, LocalStack endpoints,
// local tenant-host links, the dark Sign tile switch); none may appear in the prod
// compose. And every service that sends mail must run NODE_ENV=production — the
// guard that makes the local outbox mailer refuse to start there.
export const LOCAL_ONLY_VARS: readonly RegExp[] = [/\bMAILER_OUTBOX_[A-Z_]*\b/, /\bSES_ENDPOINT\b/, /\bAWS_SECRETS_MANAGER_ENDPOINT\b/, /\bLOCAL_MAIL\b/, /MAILER_PROVIDER\s*=\s*outbox/];

export function validateLocalOnly(composeText: string): string[] {
  const problems: string[] = [];
  for (const re of LOCAL_ONLY_VARS) {
    if (re.test(composeText)) problems.push(`local-development setting ${re.source} appears in docker-compose.prod.yml`);
  }
  const doc = parse(composeText) as { services?: Record<string, { environment?: unknown }> } | null;
  for (const [svc, def] of Object.entries(doc?.services ?? {})) {
    const env = Array.isArray(def.environment) ? def.environment.map(String) : Object.entries((def.environment ?? {}) as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`);
    const sendsMail = env.some((e) => e === 'MAILER_PROVIDER' || e.startsWith('MAILER_PROVIDER='));
    if (sendsMail && !env.includes('NODE_ENV=production')) problems.push(`service "${svc}" sends mail but does not set NODE_ENV=production`);
  }
  return problems;
}

// ── Embedded selftest (isolated fixtures; the "seeded missing-passthrough" proof) ────────
function selftest(): void {
  // Fixture 1 — a service that DROPS a required passthrough (assertion 1).
  const dropCompose = `
services:
  api:
    environment:
      - MAILER_PROVIDER
`; // ARAMO_IDENTITY_PEPPER / ADMISSION_POLICY / DNS_PROVIDER omitted
  const dropModel = parseComposeEnv(dropCompose);
  const dropDocs = new Set([
    'MAILER_PROVIDER',
    'ARAMO_IDENTITY_PEPPER',
    'ARAMO_IDENTITY_ADMISSION_POLICY',
    'DNS_PROVIDER',
  ]);
  const v1 = validateEnvPassthrough(dropModel, dropDocs, {
    api: ['ARAMO_IDENTITY_PEPPER', 'MAILER_PROVIDER'],
  });
  const caughtDrop = v1.some(
    (x) => x.kind === 'required-not-passed-through' && x.var === 'ARAMO_IDENTITY_PEPPER',
  );

  // Fixture 2 — a passthrough var absent from the operator contract (assertion 2).
  const undocCompose = `
services:
  api:
    environment:
      - GLH1_FIXTURE_UNDOCUMENTED
`;
  const undocModel = parseComposeEnv(undocCompose);
  const v2 = validateEnvPassthrough(undocModel, new Set(), {});
  const caughtUndoc = v2.some(
    (x) => x.kind === 'passthrough-not-documented' && x.var === 'GLH1_FIXTURE_UNDOCUMENTED',
  );

  // Fixture 3 — YAML anchor/alias resolution (the pepper is single-sourced across services).
  const anchorCompose = `
services:
  api:
    environment:
      - &p ARAMO_IDENTITY_PEPPER
  auth-service:
    environment:
      - *p
`;
  const anchorModel = parseComposeEnv(anchorCompose);
  const resolvedBoth =
    (anchorModel.passthroughByService['api'] ?? []).includes('ARAMO_IDENTITY_PEPPER') &&
    (anchorModel.passthroughByService['auth-service'] ?? []).includes('ARAMO_IDENTITY_PEPPER');

  // Fixture 4 — a local-only setting and a mail service without NODE_ENV=production.
  const localProblems = validateLocalOnly(`
services:
  sign-service:
    environment:
      - MAILER_PROVIDER
      - MAILER_OUTBOX_DIR=/tmp/mail
`);
  const caughtLocal = localProblems.some((x) => x.includes('MAILER_OUTBOX')) && localProblems.some((x) => x.includes('NODE_ENV=production'));

  // Fixture 5 — a guarded URL part: dropped guard (1b) and undocumented guard (2b).
  const guardModel = parseComposeEnv(`
services:
  talent-intelligence-service:
    environment:
      - INTELLIGENCE_DATABASE_URL=postgresql://u:\${FIXTURE_GUARDED_PW:?must be set}@postgres:5432/db
  other:
    environment:
      - X=\${FIXTURE_UNGUARDED:-x}
`);
  const v5 = validateEnvPassthrough(guardModel, new Set(), {}, {
    'talent-intelligence-service': ['FIXTURE_GUARDED_PW'],
    other: ['FIXTURE_UNGUARDED'],
  });
  const caughtGuard =
    v5.some((x) => x.kind === 'guarded-not-documented' && x.var === 'FIXTURE_GUARDED_PW') &&
    v5.some((x) => x.kind === 'required-guard-missing' && x.var === 'FIXTURE_UNGUARDED') &&
    !v5.some((x) => x.kind === 'required-guard-missing' && x.var === 'FIXTURE_GUARDED_PW');

  if (!caughtDrop || !caughtUndoc || !resolvedBoth || !caughtLocal || !caughtGuard) {
    console.error(
      `SELFTEST FAILED: env-passthrough checker vacuous (drop=${caughtDrop} undoc=${caughtUndoc} anchor=${resolvedBoth} local=${caughtLocal} guard=${caughtGuard}).`,
    );
    process.exit(2);
  }
}

function main(): void {
  selftest();
  const model = parseComposeEnv(readFileSync(COMPOSE, 'utf8'));
  const documented = documentedKeys(readFileSync(ENV_EXAMPLE, 'utf8'));
  const violations = validateEnvPassthrough(model, documented);
  const localOnly = validateLocalOnly(readFileSync(COMPOSE, 'utf8'));
  if (localOnly.length > 0) {
    console.error('✗ local-development settings would reach production:');
    for (const p of localOnly) console.error(`  - ${p}`);
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error('✗ env-passthrough parity violations:');
    for (const v of violations) {
      if (v.kind === 'required-not-passed-through')
        console.error(
          `  - REQUIRED var "${v.var}" is not passed through to service "${v.service}" (container would boot without it).`,
        );
      else if (v.kind === 'required-guard-missing')
        console.error(
          `  - REQUIRED guarded var "${v.var}" is not \${${v.var}:?} -guarded in service "${v.service}" (it would boot with an empty value).`,
        );
      else if (v.kind === 'guarded-not-documented')
        console.error(
          `  - guarded var "${v.var}" (compose refuses to start without it) is NOT documented in .env.prod.example.`,
        );
      else if (v.kind === 'passthrough-not-documented')
        console.error(
          `  - passthrough var "${v.var}" is NOT documented in .env.prod.example (operator never sets it → arrives empty).`,
        );
      else
        console.error(
          `  - required interpolation var "${v.var}" is NOT documented in .env.prod.example.`,
        );
    }
    process.exit(1);
  }
  console.log(
    `✓ env-passthrough: ${model.allPassthrough.size} passthrough + ${model.requiredInterpolations.size} required-interp + ${model.requiredGuards.size} guarded vars all documented; ${Object.values(REQUIRED_PASSTHROUGH).flat().length} required-manifest + ${Object.values(REQUIRED_GUARDED).flat().length} guarded-manifest entries wired.`,
  );
}

main();
