import type { SignErasureHolder, SignErasurePort, SignErasureScope } from '../../talent-identity/sign-erasure.port.js';

// Aramo-Sign-Domain-Isolation-Reconciliation-V1 — an in-memory Aramo Sign for the erasure
// engine's specs (the engine never touches the sign schema; the real contract is proven in
// sign-service's talent-erasure integration spec). Records every call; `holders` and `fail`
// steer what Sign answers.
export interface FakeSignErasure extends SignErasurePort {
  preflights: SignErasureScope[];
  erasures: Array<SignErasureScope & { run_id: string }>;
  holders: SignErasureHolder[];
  fail: string | null;
}

export function fakeSignErasure(): FakeSignErasure {
  const fake: FakeSignErasure = {
    preflights: [],
    erasures: [],
    holders: [],
    fail: null,
    async preflight(scope) {
      fake.preflights.push(scope);
      if (fake.fail !== null) throw new Error(fake.fail);
      return { holders: fake.holders, erasable: { idempotency_keys: 0, api_idempotency_keys: 0, outbox_events: 0 } };
    },
    async erase(scope) {
      fake.erasures.push(scope);
      if (fake.fail !== null) throw new Error(fake.fail);
      if (fake.holders.length > 0) return { status: 'blocked', holders: fake.holders };
      return { status: 'erased', counts: { idempotency_keys: 0, api_idempotency_keys: 0, outbox_events: 0 } };
    },
  };
  return fake;
}
