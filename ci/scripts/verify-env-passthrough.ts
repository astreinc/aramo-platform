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
  ],
  'auth-service': [
    'ARAMO_IDENTITY_PEPPER', // shared pepper (Portal P1 eligibility fingerprint) — must match api
    'MAILER_PROVIDER', // portal login mail rides the SES mailer path
  ],
};

export interface ComposeEnvModel {
  /** service id -> bare-name passthrough vars (anchor-resolved) */
  passthroughByService: Record<string, string[]>;
  /** every bare-name passthrough var across all services */
  allPassthrough: Set<string>;
  /** vars required via a no-default `${VAR}` interpolation anywhere in the file */
  requiredInterpolations: Set<string>;
}

/** Extract passthrough + required-interpolation vars from a compose document + its raw text. */
export function parseComposeEnv(composeText: string): ComposeEnvModel {
  const doc = parse(composeText) as {
    services?: Record<string, { environment?: unknown }>;
  };
  const services = doc.services ?? {};
  const passthroughByService: Record<string, string[]> = {};
  const allPassthrough = new Set<string>();

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
  }

  // No-default interpolations `${VAR}` (a `${VAR:-...}` / `${VAR:?...}` has a default/guard
  // and is therefore optional). Scanned from raw text — interpolations are literal.
  const requiredInterpolations = new Set<string>();
  const noDefault = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = noDefault.exec(composeText)) !== null) requiredInterpolations.add(m[1]);

  return { passthroughByService, allPassthrough, requiredInterpolations };
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
    | 'required-interp-not-documented';
  var: string;
  service?: string;
}

export function validateEnvPassthrough(
  model: ComposeEnvModel,
  documented: Set<string>,
  requiredManifest: Record<string, string[]> = REQUIRED_PASSTHROUGH,
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

  // ASSERTION 2 — every passthrough var is documented in the operator contract.
  for (const v of model.allPassthrough) {
    if (!documented.has(v)) violations.push({ kind: 'passthrough-not-documented', var: v });
  }
  // ... and every no-default interpolation var is documented too.
  for (const v of model.requiredInterpolations) {
    if (!documented.has(v)) violations.push({ kind: 'required-interp-not-documented', var: v });
  }

  return violations;
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

  if (!caughtDrop || !caughtUndoc || !resolvedBoth) {
    console.error(
      `SELFTEST FAILED: env-passthrough checker vacuous (drop=${caughtDrop} undoc=${caughtUndoc} anchor=${resolvedBoth}).`,
    );
    process.exit(2);
  }
}

function main(): void {
  selftest();
  const model = parseComposeEnv(readFileSync(COMPOSE, 'utf8'));
  const documented = documentedKeys(readFileSync(ENV_EXAMPLE, 'utf8'));
  const violations = validateEnvPassthrough(model, documented);
  if (violations.length > 0) {
    console.error('✗ env-passthrough parity violations:');
    for (const v of violations) {
      if (v.kind === 'required-not-passed-through')
        console.error(
          `  - REQUIRED var "${v.var}" is not passed through to service "${v.service}" (container would boot without it).`,
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
    `✓ env-passthrough: ${model.allPassthrough.size} passthrough + ${model.requiredInterpolations.size} required-interp vars all documented; ${Object.values(REQUIRED_PASSTHROUGH).flat().length} required-manifest entries wired.`,
  );
}

main();
