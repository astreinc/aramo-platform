import type { AramoLogger } from './aramo-logger.js';

// M4-close HK-PR-4 — canonical AramoLogger mock factory for unit tests.
//
// Returns a no-op AramoLogger satisfying the typed surface (log, warn,
// error, debug) with empty function implementations at each method.
// Tests inject this to satisfy the shape without coupling assertions
// to log output (the PR-9 PoC submittal pattern). When a test needs
// to spy on a specific method, it can wrap the result with vi.spyOn()
// at the spec site — the shared helper deliberately stays vitest-free
// so consuming production code can `import { ... } from '@aramo/common'`
// without dragging vitest into the runtime resolution graph.
//
// Co-located with the AramoLogger factory at libs/common/src/lib/
// logging/ so producers and test-time consumers share a single source
// of truth. PR-9 PoC (libs/submittal) initially defined this helper
// inline per spec — HK-PR-4 promotes it to the workspace-shared
// position and migrates libs/submittal to import from here.

export function makeMockLogger(): AramoLogger {
  const noop = (): void => undefined;
  return {
    log: noop,
    warn: noop,
    error: noop,
    debug: noop,
  } as unknown as AramoLogger;
}
