// Compile-time contract for the PlacementProcess lifecycle registry (§6b/§8).
//
// This file contains NO runtime behaviour — only type-level assertions. It is
// part of the library BUILD (tsconfig.lib.json includes src/**, excluding only
// src/tests/**), so `nx build placement` / tsc enforces every assertion here.
// A spec cannot do this: test files are build-excluded and vitest strips types.
//
// Each assertion is a `const _x: <Predicate> = true`. When the predicate holds
// it resolves to `true`; when it fails it resolves to `never`, and `const _x:
// never = true` is a COMPILE ERROR. So violating any contract below fails the
// build — which is exactly the directive's requirement that these be
// compile-time errors, not runtime surprises.

import {
  STATE_POSITION,
  TRANSITIONS,
  type LegalTarget,
  type PlacementState,
} from './placement-lifecycle.js';

// A helper: `Assert<true>` is `true`; `Assert<never>`/`Assert<false>` fails.
type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;

// (1) EXHAUSTIVE POSITIONS — every PlacementState declares a lifecycle position
// (§4c). If a state were added without a STATE_POSITION entry, the Exclude is
// non-never and this fails to build.
type _PositionsExhaustive = Assert<Extends<Exclude<PlacementState, keyof typeof STATE_POSITION>, never>>;

// (2) EXHAUSTIVE TRANSITIONS — every PlacementState declares a transition
// treatment (§6b). A new state without a TRANSITIONS entry fails to build.
type _TransitionsExhaustive = Assert<Extends<Exclude<PlacementState, keyof typeof TRANSITIONS>, never>>;

// (3) THE PROHIBITED EDGE (§4d) — READY_TO_START is NOT a legal target of
// OFFER_ACCEPTED. If someone added it to TRANSITIONS.OFFER_ACCEPTED, this flips
// to `never` and fails the build.
type _DirectReadyProhibited = Assert<Extends<'READY_TO_START' extends LegalTarget<'OFFER_ACCEPTED'> ? false : true, true>>;

// (4) PRE_START IS THE ENTRY (§4d) — the legal, mandatory step after acceptance.
type _PreStartIsLegal = Assert<Extends<'PRE_START' extends LegalTarget<'OFFER_ACCEPTED'> ? true : false, true>>;

// (5) STARTED IS TRANSITION-TERMINAL — it has no legal target (§4c/§5). Its
// LegalTarget union is `never`.
type _StartedHasNoTarget = Assert<Extends<LegalTarget<'STARTED'>, never>>;

// Exporting the checked types keeps them referenced (no unused-locals noise)
// while carrying zero runtime footprint.
export type PlacementLifecycleContract = [
  _PositionsExhaustive,
  _TransitionsExhaustive,
  _DirectReadyProhibited,
  _PreStartIsLegal,
  _StartedHasNoTarget,
];
