// SIGN⊥ATS NEGATIVE CONTROL — DO NOT IMPORT FROM PRODUCTION CODE.
//
// A deliberate, committed breach of the Sign⊥ATS import wall
// (Aramo-Sign-Domain-Isolation-Reconciliation-V1-Directive-v1_0-LOCKED §3 H-1): a scope:sign
// project (`sign-service`) importing a scope:ats lib (`pipeline`). It exists ONLY to PROVE
// that @nx/enforce-module-boundaries rejects such an import.
//
// Isolation (so it never reds a real target):
//   - eslint.config.mjs `ignores` ('**/sign-negative-control/**') keeps it out of the real
//     lint gate.
//   - apps/sign-service/tsconfig.app.json `exclude` keeps it out of the build.
//
// It stays COMMITTED so it is present in the nx project graph. The wall-fires spec
// (../tests/sign-negative-control.spec.ts) warms the graph, then lints THIS file with
// `eslint --no-ignore` and asserts the boundary rule fires. If this ever lints clean, the
// wall is broken.
import * as pipelineAtsLib from '@aramo/pipeline';

export const SIGN_NEGATIVE_CONTROL_REFERENCE = pipelineAtsLib;
