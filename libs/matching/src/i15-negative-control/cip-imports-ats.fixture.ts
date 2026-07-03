// I15 NEGATIVE CONTROL — DO NOT IMPORT FROM PRODUCTION CODE.
//
// A deliberate, committed breach of the CIP(Pipeline)⊥ATS import wall
// (ADR-0017 I15): a scope:cip project (`matching`) importing a scope:ats lib
// (`engagement`). It exists ONLY to PROVE that @nx/enforce-module-boundaries
// rejects such an import — the self-testing negative control the I14 privacy
// wall lacked.
//
// Isolation (so it never reds a real target):
//   - eslint.config.mjs `ignores` ('**/i15-negative-control/**') keeps it out
//     of the real lint:nx-boundaries gate.
//   - libs/matching/tsconfig.lib.json `exclude` keeps it out of the build
//     (matching's build tsconfig does not map @aramo/engagement).
//
// It stays COMMITTED so it is present in the nx project graph at graph-compute
// time — the boundary rule resolves its source project from that graph. The
// wall-fires spec (../tests/i15-negative-control.spec.ts) warms the graph, then
// lints THIS file with `eslint --no-ignore` and asserts the boundary rule fires
// (CI-red on a CIP→ATS breach). If this ever lints clean, the wall is broken.
import * as engagementAtsLib from '@aramo/engagement';

export const I15_NEGATIVE_CONTROL_REFERENCE = engagementAtsLib;
