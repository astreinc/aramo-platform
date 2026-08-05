// CANONICAL integration-root READER (PR-B, Dev Execution Model v1.4 §12).
//
// The ONLY module that parses ci/integration-roots.json. Every runner consumes
// this reader — ci-integration.sh (via the print CLI below), prepush.ts (import),
// package.json tests:integration (via run-integration.ts), and the coverage guard
// (check-integration-roots.ts). No runner embeds its own root list; the guard
// fails the build if one does.
//
// Run directly to print the executable roots, one per line (the shell contract):
//   node --import jiti/register ci/scripts/integration-roots.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const REPO_ROOT = resolve(__dirname, '..', '..');
export const REGISTRY_PATH = resolve(REPO_ROOT, 'ci', 'integration-roots.json');

export interface CoverageAlias {
  /** The project whose integration proof is hosted elsewhere (NOT an executable root). */
  project: string;
  /** The executable root that actually runs the proof. */
  coveredBy: string;
  /** Exact path to the integration spec that proves this project. */
  proof: string;
  /** One-line justification. */
  reason: string;
}

export interface Exemption {
  /** The integration-bearing project excluded from requiring its own root. */
  project: string;
  /** Exact detected integration file the exemption covers. */
  file: string;
  /** One-line justification (a narrow Ruling-1 class only). */
  reason: string;
}

export interface IntegrationRegistry {
  roots: string[];
  coverageAliases: CoverageAlias[];
  exemptions: Exemption[];
}

let cached: IntegrationRegistry | undefined;

export function readRegistry(): IntegrationRegistry {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Partial<IntegrationRegistry>;
  cached = {
    roots: raw.roots ?? [],
    coverageAliases: raw.coverageAliases ?? [],
    exemptions: raw.exemptions ?? [],
  };
  return cached;
}

/** The executable integration roots, in registry order. */
export function getRoots(): string[] {
  return readRegistry().roots;
}

export function getCoverageAliases(): CoverageAlias[] {
  return readRegistry().coverageAliases;
}

export function getExemptions(): Exemption[] {
  return readRegistry().exemptions;
}

// Print CLI — the shell contract for ci-integration.sh. Emit each root on its own
// line so bash can read them into an array without jq (jq is not a guaranteed
// dependency; Node is).
if (process.argv[1] !== undefined && /[/\\]integration-roots\.ts$/.test(process.argv[1])) {
  process.stdout.write(getRoots().join('\n') + '\n');
}
