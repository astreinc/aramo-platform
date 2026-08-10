// PLATFORM⊥ATS NEGATIVE CONTROL — DO NOT IMPORT FROM PRODUCTION CODE.
//
// A deliberate, committed breach of the Platform⊥ATS import wall
// (Platform-Console Increment-1, ADR-0029 R-TAGS): a scope:platform project
// (`platform-admin`) importing a scope:ats lib (`engagement`). It exists ONLY
// to PROVE that @nx/enforce-module-boundaries rejects such an import — the
// self-testing negative control for the platform tier, mirroring the I15
// CIP⊥ATS control.
//
// Isolation (so it never reds a real target):
//   - eslint.config.mjs `ignores` ('**/platform-negative-control/**') keeps it
//     out of the real lint:nx-boundaries gate.
//   - apps/platform-admin/tsconfig.app.json `exclude` keeps it out of the build
//     (platform-admin's build tsconfig does not map @aramo/engagement).
//
// It stays COMMITTED so it is present in the nx project graph at graph-compute
// time — the boundary rule resolves its source project from that graph. The
// wall-fires spec (../tests/platform-negative-control.spec.ts) warms the graph,
// then lints THIS file with `eslint --no-ignore` and asserts the boundary rule
// fires (CI-red on a PLATFORM→ATS breach). If this ever lints clean, the wall
// is broken.
import * as engagementAtsLib from '@aramo/engagement';

export const PLATFORM_NEGATIVE_CONTROL_REFERENCE = engagementAtsLib;
