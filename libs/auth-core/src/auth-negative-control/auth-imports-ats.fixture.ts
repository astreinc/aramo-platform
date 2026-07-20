// AUTH NEGATIVE CONTROL — DO NOT IMPORT FROM PRODUCTION CODE.
//
// A deliberate, committed breach of the scope:auth wall (ADR-0021 §4): a
// scope:auth project (`auth-core`) importing a scope:ats lib (`engagement`). It
// exists ONLY to PROVE that @nx/enforce-module-boundaries rejects such an import
// — the self-testing negative control every wall in this repo ships (i15 /
// platform / portal precedent, R-P5b-5).
//
// Isolation (so it never reds a real target):
//   - eslint.config.mjs `ignores` ('**/auth-negative-control/**') keeps it out
//     of the real lint:nx-boundaries gate.
//   - libs/auth-core/tsconfig.lib.json `exclude` keeps it out of the build
//     (auth-core's build tsconfig does not map @aramo/engagement).
//
// It stays COMMITTED so it is present in the nx project graph at graph-compute
// time — the boundary rule resolves its source project from that graph. The
// wall-fires spec (../tests/auth-negative-control.spec.ts) warms the graph, then
// lints THIS file with `eslint --no-ignore` and asserts the boundary rule fires
// (CI-red on a scope:auth → scope:ats breach). If this ever lints clean, the wall
// is broken.
import * as engagementAtsLib from '@aramo/engagement';

export const AUTH_NEGATIVE_CONTROL_REFERENCE = engagementAtsLib;
