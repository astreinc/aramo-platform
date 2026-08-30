import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

// Lane 2 / L2-G (Part 3, R-CONTROL) — STRUCTURAL NEGATIVE CONTROL for the
// Placement⊥Pipeline independence wall.
//
// The I15 CIP⊥ATS wall (libs/matching i15-negative-control) is TAG-based
// (@nx/enforce-module-boundaries on scope:cip vs scope:ats). It does NOT cover
// THIS boundary: libs/placement and libs/pipeline are BOTH scope:ats, so no tag
// rule separates them. The L2-G orchestration deliberately keeps Placement from
// ever importing Pipeline (the app-root orchestrator is the ONLY composer, by
// stored lineage + a raw outbox read). This spec proves that structurally —
// against the REAL nx project graph, not a hand-maintained list — by computing
// the transitive dependency closure of `placement` and asserting `pipeline`
// (and the bridge that composes it) is not in it.
//
// If a future edit makes libs/placement `import` from @aramo/pipeline (directly
// or transitively), the edge lands in the nx graph and THIS spec goes red — the
// wall and its control fail together, by design.
//
// The nx project graph resolves file-based + deterministic under NX_DAEMON=false.

const ROOT = resolve(__dirname, '../../../..');
const GRAPH_FILE = resolve(tmpdir(), 'aramo-l2g-placement-independence-graph.json');

interface ProjectGraph {
  graph: {
    nodes: Record<string, unknown>;
    dependencies: Record<string, Array<{ source: string; target: string; type: string }>>;
  };
}

function transitiveClosure(
  start: string,
  dependencies: ProjectGraph['graph']['dependencies'],
): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    for (const edge of dependencies[node] ?? []) {
      if (!seen.has(edge.target)) {
        seen.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  return seen;
}

describe('Placement⊥Pipeline independence — structural negative control', () => {
  it('libs/placement transitive dependency closure EXCLUDES @aramo/pipeline', () => {
    const env = { ...process.env, NX_DAEMON: 'false' };
    const gen = spawnSync(
      'npx',
      ['nx', 'graph', `--file=${GRAPH_FILE}`],
      { cwd: ROOT, encoding: 'utf8', timeout: 300_000, env },
    );
    expect(
      gen.status,
      `failed to generate the nx project graph.\nstdout:\n${gen.stdout}\nstderr:\n${gen.stderr}`,
    ).toBe(0);

    const { graph } = JSON.parse(readFileSync(GRAPH_FILE, 'utf8')) as ProjectGraph;

    // Non-vacuity guard 1: both projects must be REAL nodes — a typo'd name would
    // make the exclusion pass vacuously.
    expect(graph.nodes['placement'], 'placement project missing from graph').toBeDefined();
    expect(graph.nodes['pipeline'], 'pipeline project missing from graph').toBeDefined();

    const closure = transitiveClosure('placement', graph.dependencies);

    // Non-vacuity guard 2: the closure computation actually traverses edges —
    // placement genuinely depends on @aramo/common. An empty/broken closure would
    // make the exclusion below meaningless.
    expect(closure.has('common'), 'expected placement→common edge in the closure').toBe(true);

    // THE WALL: placement never reaches pipeline (directly or transitively).
    expect(
      closure.has('pipeline'),
      `libs/placement must NOT depend on @aramo/pipeline. closure=${[...closure].sort().join(', ')}`,
    ).toBe(false);

    // The bridge that COMPOSES pipeline is likewise not something placement knows
    // about — placement stays untouched; only the app-root orchestrator composes.
    expect(
      closure.has('placement-pipeline-bridge'),
      `libs/placement must NOT depend on the bridge. closure=${[...closure].sort().join(', ')}`,
    ).toBe(false);
  }, 300_000);
});
