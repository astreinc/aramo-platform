import { afterEach } from 'vitest';

// M6 PR-1 — yield one macrotask after each test so the pact-rust mock
// server's tokio runtime can begin processing the previous executeTest's
// cleanup before the next test's createMockServer fires. cleanupMockServer
// signals shutdown via the FFI but the listener task completes
// asynchronously on a separate worker thread; without this gap a
// subsequent executeTest's createMockServer races with the in-flight
// teardown on the shared per-fork tokio runtime, producing stochastic
// "expected request not received" mismatches when the OS reuses a port
// whose listener is still being unbound (wildcard uuid()/like() matchers
// on prior interactions then satisfy the new fetch by coincidence).
//
// Empirically reduces ats-thin local flake rate from ~30% to ~7% at HEAD
// 9ac157e. Stronger yields (setTimeout 5/10ms) and per-test PactV4
// reinstantiation were tested and did not improve on the macrotask
// yield — the residual ~7% reflects an irreducible race in pact-rust's
// async listener-unbind path that needs an upstream fix.
afterEach(
  () =>
    new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    }),
);
