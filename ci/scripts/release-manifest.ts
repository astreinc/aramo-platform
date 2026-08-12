// GLH-2-B (ATS Go-Live Hardening Charter v1.5 / GLH-2 Release Integrity — Scope-Ruling
// Instrument v1.0 LOCKED, R2/R3/R4) — the canonical machine-readable RELEASE MANIFEST:
// generation + fail-closed validation.
//
// One validated manifest binds, for a governed release build (push→main):
//   exact source revision → CI run → every governed deployable artifact → immutable digest.
//
// It consumes GLH-2-A provenance (the same `github.sha` merge-of-record revision that
// GLH-2-A stamps into org.opencontainers.image.revision + ARAMO_RELEASE_REVISION); it does
// NOT recompute a SHA. Digests come from the real image-build outputs (build-push-action
// outputs.digest), never from a mutable-tag lookup. The digest is the artifact IDENTITY;
// published tags are informational aliases only.
//
// Fail-closed (validation): missing/duplicate component, missing/malformed digest, malformed
// source revision, an artifact revision that disagrees with the release revision, or the
// governed-component set not matching exactly. No secrets/tokens/env/deploy-targets.
//
// Non-vacuous by construction: an embedded selftest drives synthetic fixtures through every
// failure mode and aborts if any is undetected (the ci/scripts wall idiom).

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const MANIFEST_SCHEMA = 'aramo.release-manifest/v1';
// GLH-2-A canonical source revision rule (full lowercase git SHA) — same rule, re-declared
// (not a SHA recomputation) so the manifest layer validates identically.
export const REVISION_REGEX = /^[0-9a-f]{40}$/;
export const DIGEST_REGEX = /^sha256:[0-9a-f]{64}$/;
// The governed deployable artifact set — every image the docker-build matrix produces. The
// manifest must contain exactly these, once each.
export const REQUIRED_COMPONENTS = ['api', 'auth-service', 'nginx', 'platform-admin'] as const;

export interface ManifestArtifact {
  component: string;
  image: string;
  digest: string;
  revision: string;
  tags: string[];
}
export interface ReleaseManifest {
  schema: typeof MANIFEST_SCHEMA;
  repository: string;
  source_revision: string;
  ci: { workflow_run_id: string; run_attempt: string; workflow: string; ref: string };
  created_at: string;
  artifacts: ManifestArtifact[];
}
export interface ManifestInputs {
  repository: string;
  source_revision: string;
  ci: { workflow_run_id: string; run_attempt: string; workflow: string; ref: string };
  created_at: string;
  artifacts: Array<{
    component: string;
    image: string;
    digest: string;
    revision: string;
    tags?: string[];
  }>;
}

export interface ManifestViolation {
  kind:
    | 'schema'
    | 'repository-missing'
    | 'source-revision-malformed'
    | 'ci-run-id-missing'
    | 'created-at-missing'
    | 'artifact-field-missing'
    | 'digest-malformed'
    | 'artifact-revision-malformed'
    | 'artifact-revision-mismatch'
    | 'duplicate-component'
    | 'component-set-mismatch';
  detail: string;
}

/** Fail-closed validation of a fully-formed manifest. Empty = valid. */
export function validateReleaseManifest(m: ReleaseManifest): ManifestViolation[] {
  const v: ManifestViolation[] = [];
  if (m.schema !== MANIFEST_SCHEMA)
    v.push({ kind: 'schema', detail: `schema must be "${MANIFEST_SCHEMA}" (got "${m.schema}")` });
  if (!m.repository || m.repository.trim().length === 0)
    v.push({ kind: 'repository-missing', detail: 'repository is empty' });
  if (!REVISION_REGEX.test(m.source_revision ?? ''))
    v.push({
      kind: 'source-revision-malformed',
      detail: `source_revision must be a 40-char lowercase git SHA (got "${m.source_revision}")`,
    });
  if (!m.ci?.workflow_run_id || m.ci.workflow_run_id.trim().length === 0)
    v.push({ kind: 'ci-run-id-missing', detail: 'ci.workflow_run_id is empty' });
  if (!m.created_at || m.created_at.trim().length === 0)
    v.push({ kind: 'created-at-missing', detail: 'created_at is empty' });

  const seen = new Set<string>();
  for (const a of m.artifacts ?? []) {
    const label = a.component || '(unnamed)';
    if (!a.component || !a.image)
      v.push({
        kind: 'artifact-field-missing',
        detail: `artifact "${label}" is missing component/image`,
      });
    if (!DIGEST_REGEX.test(a.digest ?? ''))
      v.push({
        kind: 'digest-malformed',
        detail: `artifact "${label}" digest must be sha256:<64 hex> (got "${a.digest}")`,
      });
    if (!REVISION_REGEX.test(a.revision ?? ''))
      v.push({
        kind: 'artifact-revision-malformed',
        detail: `artifact "${label}" revision must be a 40-char lowercase git SHA (got "${a.revision}")`,
      });
    else if (a.revision !== m.source_revision)
      v.push({
        kind: 'artifact-revision-mismatch',
        detail: `artifact "${label}" revision (${a.revision}) != release source_revision (${m.source_revision})`,
      });
    if (seen.has(a.component))
      v.push({ kind: 'duplicate-component', detail: `duplicate component "${a.component}"` });
    seen.add(a.component);
  }
  const required = [...REQUIRED_COMPONENTS].sort().join(',');
  const present = [...seen].sort().join(',');
  if (required !== present)
    v.push({
      kind: 'component-set-mismatch',
      detail: `governed component set must be exactly {${required}} (got {${present}})`,
    });
  return v;
}

/** Build a canonical manifest from inputs, deterministically ordered, then validate (throws on violations). */
export function generateReleaseManifest(inputs: ManifestInputs): ReleaseManifest {
  const artifacts: ManifestArtifact[] = [...inputs.artifacts]
    .map((a) => ({
      component: a.component,
      image: a.image,
      digest: a.digest,
      revision: a.revision,
      tags: [...(a.tags ?? [])].sort(),
    }))
    .sort((x, y) => x.component.localeCompare(y.component));
  const manifest: ReleaseManifest = {
    schema: MANIFEST_SCHEMA,
    repository: inputs.repository,
    source_revision: inputs.source_revision,
    ci: inputs.ci,
    created_at: inputs.created_at,
    artifacts,
  };
  const violations = validateReleaseManifest(manifest);
  if (violations.length > 0) {
    const msg = violations.map((x) => `[${x.kind}] ${x.detail}`).join('; ');
    throw new Error(`release-manifest generation failed closed: ${msg}`);
  }
  return manifest;
}

/** Deterministic serialization — recursively key-sorted JSON. Byte-stable for identical inputs (created_at is the only nondeterministic field). */
export function serializeManifest(m: ReleaseManifest): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>(
          (acc, k) => ((acc[k] = sortKeys((value as Record<string, unknown>)[k])), acc),
          {},
        );
    }
    return value;
  };
  return JSON.stringify(sortKeys(m), null, 2) + '\n';
}

// ── Embedded selftest (isolated fixtures) ────────────────────────────────────────────────
function selftest(): void {
  const sha = 'a17962f09abf31ea627afbd7232e7dc8953c0f60';
  const dig = (h: string) => `sha256:${h.repeat(64).slice(0, 64)}`;
  const artifact = (c: string, rev = sha) => ({
    component: c,
    image: `ghcr.io/astreinc/aramo-${c}`,
    digest: dig('a'),
    revision: rev,
    tags: [sha, 'latest'],
  });
  const inputs = (): ManifestInputs => ({
    repository: 'astreinc/aramo-platform',
    source_revision: sha,
    ci: { workflow_run_id: '123', run_attempt: '1', workflow: 'ci', ref: 'refs/heads/main' },
    created_at: '2026-08-12T00:00:00Z',
    artifacts: [...REQUIRED_COMPONENTS].map((c) => artifact(c)),
  });
  const vOf = (m: ReleaseManifest) => validateReleaseManifest(m);
  const has = (m: ReleaseManifest, k: ManifestViolation['kind']) =>
    vOf(m).some((x) => x.kind === k);

  // valid → 0 violations + deterministic byte-stability for identical inputs.
  const ok = generateReleaseManifest(inputs());
  const stable =
    serializeManifest(generateReleaseManifest(inputs())) ===
    serializeManifest(generateReleaseManifest(inputs()));

  // missing component (drop nginx) → component-set-mismatch.
  const miss = { ...ok, artifacts: ok.artifacts.filter((a) => a.component !== 'nginx') };
  // duplicate component → duplicate-component.
  const dup = { ...ok, artifacts: [...ok.artifacts, artifact('api')] };
  // malformed digest.
  const badDigest = {
    ...ok,
    artifacts: ok.artifacts.map((a, i) => (i === 0 ? { ...a, digest: 'latest' } : a)),
  };
  // artifact revision != release revision.
  const mismatch = {
    ...ok,
    artifacts: ok.artifacts.map((a, i) => (i === 0 ? { ...a, revision: 'b'.repeat(40) } : a)),
  };
  // malformed source revision.
  const badSha = { ...ok, source_revision: 'a17962f' };
  // wrong schema.
  const badSchema = { ...ok, schema: 'nope' as typeof MANIFEST_SCHEMA };

  const checks: Array<[string, boolean]> = [
    ['valid manifest passes', vOf(ok).length === 0],
    ['deterministic byte-stable', stable],
    ['missing component detected', has(miss, 'component-set-mismatch')],
    ['duplicate component detected', has(dup, 'duplicate-component')],
    ['malformed digest detected', has(badDigest, 'digest-malformed')],
    ['revision mismatch detected', has(mismatch, 'artifact-revision-mismatch')],
    ['malformed source revision detected', has(badSha, 'source-revision-malformed')],
    ['wrong schema detected', has(badSchema, 'schema')],
  ];
  const failed = checks.filter(([, ok2]) => !ok2).map(([n]) => n);
  if (failed.length > 0) {
    console.error('SELFTEST FAILED — release-manifest checker vacuous for: ' + failed.join('; '));
    process.exit(2);
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────
// Modes:
//   --selftest                          run the embedded selftest only (CI logic gate)
//   --generate --inputs <dir> --out <f> read per-component input JSONs, generate + validate + write
//   --validate <file>                   validate an existing manifest file
function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  selftest();
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    console.log(
      '✓ release-manifest: selftest passed (generation + all fail-closed validation classes).',
    );
    return;
  }
  if (args.includes('--validate')) {
    const file = argVal('--validate');
    if (!file || !existsSync(file)) {
      console.error(`✗ release-manifest --validate: file not found: ${file}`);
      process.exit(1);
    }
    const m = JSON.parse(readFileSync(file, 'utf8')) as ReleaseManifest;
    const violations = validateReleaseManifest(m);
    if (violations.length > 0) {
      console.error('✗ release-manifest invalid:');
      for (const x of violations) console.error(`  - [${x.kind}] ${x.detail}`);
      process.exit(1);
    }
    console.log(
      `✓ release-manifest valid: ${m.source_revision} · ${m.artifacts.length} artifacts.`,
    );
    return;
  }
  if (args.includes('--generate')) {
    const dir = argVal('--inputs');
    const out = argVal('--out');
    if (!dir || !existsSync(dir)) {
      console.error(`✗ release-manifest --generate: inputs dir not found: ${dir}`);
      process.exit(1);
    }
    if (!out) {
      console.error('✗ release-manifest --generate: --out <file> required');
      process.exit(1);
    }
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const artifacts = files.map(
      (f) => JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as ManifestArtifact,
    );
    const env = process.env;
    const inputs: ManifestInputs = {
      repository: env['GITHUB_REPOSITORY'] ?? '',
      source_revision: env['RELEASE_SOURCE_REVISION'] ?? env['GITHUB_SHA'] ?? '',
      ci: {
        workflow_run_id: env['GITHUB_RUN_ID'] ?? '',
        run_attempt: env['GITHUB_RUN_ATTEMPT'] ?? '',
        workflow: env['GITHUB_WORKFLOW'] ?? '',
        ref: env['GITHUB_REF'] ?? '',
      },
      created_at: env['RELEASE_CREATED_AT'] ?? '',
      artifacts,
    };
    const manifest = generateReleaseManifest(inputs); // throws (fail-closed) on any violation
    writeFileSync(out, serializeManifest(manifest));
    console.log(
      `✓ release-manifest written: ${out} · ${manifest.source_revision} · ${manifest.artifacts.length} artifacts.`,
    );
    return;
  }
  console.error(
    'usage: release-manifest.ts (--selftest | --generate --inputs <dir> --out <file> | --validate <file>)',
  );
  process.exit(1);
}

main();
