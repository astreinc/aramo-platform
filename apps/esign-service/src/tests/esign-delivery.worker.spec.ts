import { describe, expect, it } from 'vitest';
import type { OutboxDeliveryService } from '@aramo/esign';

import { EsignDeliveryWorker } from '../app/esign-delivery.worker.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('EsignDeliveryWorker (DEC-B lifecycle worker)', () => {
  it('overlap guard: a second tick is a no-op while a drain is in flight', async () => {
    let calls = 0;
    const gate = deferred<{ claimed: number; delivered: number; failed: number }>();
    const delivery = {
      deliverDueBatch: () => {
        calls += 1;
        return gate.promise;
      },
    } as unknown as OutboxDeliveryService;

    const worker = new EsignDeliveryWorker(delivery);
    const t1 = worker.tick();
    const t2 = worker.tick(); // must early-return: a drain is already running

    expect(calls).toBe(1);

    gate.resolve({ claimed: 0, delivered: 0, failed: 0 });
    await Promise.all([t1, t2]);

    // Guard released — a subsequent tick runs again.
    await worker.tick();
    expect(calls).toBe(2);
  });

  it('refuses to tick after shutdown', async () => {
    let calls = 0;
    const delivery = {
      deliverDueBatch: async () => {
        calls += 1;
        return { claimed: 0, delivered: 0, failed: 0 };
      },
    } as unknown as OutboxDeliveryService;

    const worker = new EsignDeliveryWorker(delivery);
    await worker.onApplicationShutdown();
    await worker.tick();
    expect(calls).toBe(0);
  });
});
