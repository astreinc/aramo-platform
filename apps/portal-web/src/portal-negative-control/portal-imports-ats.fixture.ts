// PORTAL⊥ATS NEGATIVE CONTROL — DO NOT IMPORT FROM PRODUCTION CODE.
//
// A deliberate, committed breach of the Portal⊥ATS import wall for the NEW
// scope:portal FE app (Portal P1 PR-3 §PR-3.1): apps/portal-web (scope:portal)
// importing a scope:ats lib (@aramo/engagement). It exists ONLY to PROVE that
// @nx/enforce-module-boundaries rejects such an import for portal-web — the
// self-testing negative control, mirroring the platform-web control and the I15
// CIP⊥ATS control.
//
// Isolation (so it never reds a real target):
//   - eslint.config.mjs `ignores` ('**/portal-negative-control/**') keeps it out
//     of the real lint:nx-boundaries gate.
//   - tsconfig.app.json + tsconfig.spec.json `exclude` keep it out of the build
//     and the unit compile.
//
// It stays COMMITTED so it is present in the nx project graph at graph-compute
// time — the boundary rule resolves its source project from that graph. The
// wall-fires spec (../tests/portal-web-negative-control.spec.ts) warms the graph,
// then lints THIS file with `eslint --no-ignore` and asserts the boundary rule
// fires (CI-red on a PORTAL→ATS breach). If this ever lints clean, the wall is
// broken.
import * as engagementAtsLib from '@aramo/engagement';

export const PORTAL_WEB_NEGATIVE_CONTROL_REFERENCE = engagementAtsLib;
