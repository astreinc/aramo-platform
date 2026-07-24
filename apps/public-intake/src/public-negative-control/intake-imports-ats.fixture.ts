// PUBLIC⊥ATS NEGATIVE CONTROL — DO NOT IMPORT FROM PRODUCTION CODE.
//
// A deliberate, committed breach of the Public⊥ATS import wall for the
// public-intake app (PUB-5 §1.2): a scope:public project (`public-intake`)
// importing a scope:ats lib (`engagement`). It exists ONLY to PROVE that
// @nx/enforce-module-boundaries rejects such an import — the self-testing
// negative control, mirroring the audited apps/public-web pattern. scope:public
// has an EMPTY allowlist, so ANY tagged-lib import is a breach.
//
// Isolation (so it never reds a real target):
//   - eslint.config.mjs `ignores` ('**/public-negative-control/**') already
//     covers this path (verified — no new entry added).
//   - apps/public-intake/tsconfig.app.json `exclude` keeps it out of the build.
//
// It stays COMMITTED so it is present in the nx project graph at graph-compute
// time — the boundary rule resolves its source project from that graph. The
// wall-fires spec (../tests/public-intake-negative-control.spec.ts) warms the
// graph, then lints THIS file with `eslint --no-ignore` and asserts the
// boundary rule fires (CI-red on a PUBLIC→ATS breach). If this ever lints
// clean, the wall is broken.
import * as engagementAtsLib from '@aramo/engagement';

export const INTAKE_NEGATIVE_CONTROL_REFERENCE = engagementAtsLib;
