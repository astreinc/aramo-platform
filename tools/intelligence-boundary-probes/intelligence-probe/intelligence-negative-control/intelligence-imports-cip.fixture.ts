// ATI-SEP-1 A7 NEGATIVE CONTROL — DO NOT IMPORT FROM PRODUCTION CODE.
//
// A deliberate, committed breach of the ATS / Talent Intelligence wall
// (ADR-0036 Decision 1): a scope:intelligence project importing a scope:cip lib.
// eslint.config.mjs ignores '**/intelligence-negative-control/**' so the real
// lint gate stays green; the wall-fires spec
// (libs/intelligence-core/src/tests/intelligence-boundary-negative-control.spec.ts)
// lints THIS file with `eslint --no-ignore` and asserts
// @nx/enforce-module-boundaries rejects it. If it ever lints clean, the wall is broken.
import * as talentTrustCipLib from '@aramo/talent-trust';

export const INTELLIGENCE_TO_CIP_NEGATIVE_CONTROL = talentTrustCipLib;
