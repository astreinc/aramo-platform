import { describe, expect, it, vi } from 'vitest';
import type { AramoLogger } from '@aramo/common';
import type { AramoEventEnvelope } from '@aramo/events';
import type {
  TalentIntakeHandleOutcome,
  TalentIntakeMessageHandler,
} from '@aramo/talent-record';

import { SingleBoxTalentIntakePublisher } from '../talent-intake-consumer/singlebox-talent-intake-publisher.js';

// ADR-0033 / single-box — the OUTBOX_PUBLISHER_PORT adapter for
// TALENT_INTAKE_TRANSPORT=singlebox. Delivers each canonical outbox envelope to
// the in-process TalentIntakeMessageHandler and maps the handler outcome onto the
// drain's publish contract (processed/skipped/malformed → published; retryable /
// unexpected throw → failed/retryable). No AWS, no extraction logic here.

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as AramoLogger;

function env(id: string): AramoEventEnvelope {
  // The adapter reads only event_id + correlation_id; the (faked) handler ignores
  // the rest. A minimal envelope is sufficient and keeps the proof focused.
  return { event_id: id, correlation_id: `corr-${id}` } as AramoEventEnvelope;
}

function handlerReturning(
  outcomes: Record<string, TalentIntakeHandleOutcome> | TalentIntakeHandleOutcome,
): { handler: TalentIntakeMessageHandler; handle: ReturnType<typeof vi.fn> } {
  const handle = vi.fn(async (e: AramoEventEnvelope): Promise<TalentIntakeHandleOutcome> => {
    if (typeof (outcomes as TalentIntakeHandleOutcome).status === 'string') {
      return outcomes as TalentIntakeHandleOutcome;
    }
    return (outcomes as Record<string, TalentIntakeHandleOutcome>)[e.event_id];
  });
  return { handler: { handle } as unknown as TalentIntakeMessageHandler, handle };
}

describe('SingleBoxTalentIntakePublisher', () => {
  // Proof #4 — delivers the canonical envelope to TalentIntakeMessageHandler.handle.
  it('§4 delivers each envelope to the message handler', async () => {
    const { handler, handle } = handlerReturning({ status: 'processed' });
    const pub = new SingleBoxTalentIntakePublisher(handler, logger);
    const e = env('e1');
    await pub.publish([e]);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(e);
  });

  // Proof #5 — a 'processed' delivery acknowledges ONLY that event (published).
  it("§5 'processed' acknowledges only the delivered event", async () => {
    const { handler } = handlerReturning({
      e1: { status: 'processed' },
      e2: { status: 'retryable', reason: 'boom' },
    });
    const pub = new SingleBoxTalentIntakePublisher(handler, logger);
    const res = await pub.publish([env('e1'), env('e2')]);
    expect(res.published_event_ids).toEqual(['e1']);
    expect(res.failed_event_ids).toEqual(['e2']);
  });

  // Business-result vs transport-failure: a terminal FAILED/PARTIAL extraction is
  // reported by the handler as 'processed' → it is ACKNOWLEDGED, never retried as
  // if it were a transport failure. 'skipped'/'malformed' are also acked (no loop).
  it('§acks processed | skipped | malformed; never loops them', async () => {
    const { handler } = handlerReturning({
      e1: { status: 'processed' },
      e2: { status: 'skipped', reason: 'draft_not_found' },
      e3: { status: 'malformed', reason: 'unsupported_event_type:x' },
    });
    const pub = new SingleBoxTalentIntakePublisher(handler, logger);
    const res = await pub.publish([env('e1'), env('e2'), env('e3')]);
    expect(res.published_event_ids.sort()).toEqual(['e1', 'e2', 'e3']);
    expect(res.failed_event_ids).toEqual([]);
  });

  // Proof #6 — a 'retryable' outcome leaves the event unpublished (retried via the
  // drain's lease machinery), never lost.
  it("§6 'retryable' leaves the event for retry (failed)", async () => {
    const { handler } = handlerReturning({ status: 'retryable', reason: 'processing_error' });
    const pub = new SingleBoxTalentIntakePublisher(handler, logger);
    const res = await pub.publish([env('e1')]);
    expect(res.published_event_ids).toEqual([]);
    expect(res.failed_event_ids).toEqual(['e1']);
  });

  // Proof #6 (cont.) — an UNEXPECTED throw out of the handler is transient: the
  // event stays retryable and publish() NEVER throws for a per-envelope failure.
  it('§6 an unexpected handler throw is treated as retryable, not lost, and does not throw', async () => {
    const handle = vi.fn(async () => {
      throw new Error('kaboom');
    });
    const handler = { handle } as unknown as TalentIntakeMessageHandler;
    const pub = new SingleBoxTalentIntakePublisher(handler, logger);
    const res = await pub.publish([env('e1'), env('e2')]);
    expect(res.failed_event_ids.sort()).toEqual(['e1', 'e2']);
    expect(res.published_event_ids).toEqual([]);
  });

  // Port contract — every envelope id appears in exactly one result array.
  it('§reports every envelope id exactly once across the two arrays', async () => {
    const { handler } = handlerReturning({
      e1: { status: 'processed' },
      e2: { status: 'retryable', reason: 'x' },
      e3: { status: 'skipped', reason: 'y' },
    });
    const pub = new SingleBoxTalentIntakePublisher(handler, logger);
    const res = await pub.publish([env('e1'), env('e2'), env('e3')]);
    const all = [...res.published_event_ids, ...res.failed_event_ids].sort();
    expect(all).toEqual(['e1', 'e2', 'e3']);
  });
});
