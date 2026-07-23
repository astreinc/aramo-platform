// PUBLIC⊥ATS NEGATIVE CONTROL — DO NOT IMPORT FROM PRODUCTION CODE.
//
// A deliberate, committed breach of the Public⊥ATS import wall
// (PUB-1 PR-1a §2.2, Amendment v1.1 G0-R1): a scope:public project
// (`public-web`) importing a scope:ats lib (`engagement`). It exists ONLY to
// PROVE that @nx/enforce-module-boundaries rejects such an import — the
// self-testing negative control for the public tier, mirroring the platform
// (PLATFORM⊥ATS) and I15 (CIP⊥ATS) controls. scope:public's legal closure is
// EMPTY, so ANY tagged-lib import is a breach; @aramo/engagement is the ats-lib
// the platform control also uses.
//
// Isolation (so it never reds a real target):
//   - eslint.config.mjs `ignores` ('**/public-negative-control/**') keeps it
//     out of the real lint:nx-boundaries gate.
//   - apps/public-web/tsconfig.json `exclude` keeps it out of the build /
//     `astro check` (public-web's tsconfig does not map @aramo/engagement).
//
// It stays COMMITTED so it is present in the nx project graph at graph-compute
// time — the boundary rule resolves its source project from that graph. The
// wall-fires spec (../tests/public-web-negative-control.spec.ts) warms the graph,
// then lints THIS file with `eslint --no-ignore` and asserts the boundary rule
// fires (CI-red on a PUBLIC→ATS breach). If this ever lints clean, the wall
// is broken.
import * as engagementAtsLib from '@aramo/engagement';

export const PUBLIC_NEGATIVE_CONTROL_REFERENCE = engagementAtsLib;
