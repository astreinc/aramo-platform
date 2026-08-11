// PLATFORM⊥ATS NEGATIVE CONTROL — DO NOT IMPORT FROM PRODUCTION CODE.
//
// A deliberate, committed breach of the Platform⊥ATS import wall for the NEW
// scope:platform FE app (Platform-Console Inc-2 PR-2 §3): apps/platform-web
// (scope:platform) importing a scope:ats lib (@aramo/selection). It exists ONLY
// to PROVE that @nx/enforce-module-boundaries rejects such an import for
// platform-web — the self-testing negative control, mirroring the platform-admin
// control and the I15 CIP⊥ATS control.
//
// Isolation (so it never reds a real target):
//   - eslint.config.mjs `ignores` ('**/platform-negative-control/**') keeps it
//     out of the real lint:nx-boundaries gate.
//   - tsconfig.app.json + tsconfig.spec.json `exclude` keep it out of the build
//     and the unit compile.
//
// It stays COMMITTED so it is present in the nx project graph at graph-compute
// time — the boundary rule resolves its source project from that graph. The
// wall-fires spec (../tests/platform-web-negative-control.spec.ts) warms the
// graph, then lints THIS file with `eslint --no-ignore` and asserts the boundary
// rule fires (CI-red on a PLATFORM→ATS breach). If this ever lints clean, the
// wall is broken.
import * as selectionAtsLib from '@aramo/selection';

export const PLATFORM_WEB_NEGATIVE_CONTROL_REFERENCE = selectionAtsLib;
