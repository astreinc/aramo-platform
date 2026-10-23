import type { AramoEventEnvelope } from '@aramo/events';
import type { TalentEventPayload } from '@aramo/talent-record';

// ATI-SEP-1 A3 — the in-process consumers of the ATS talent outbox
// (talent.created / talent.profile_updated / talent.erased). Each handler runs
// POST-COMMIT, off the lease-safe drain, never on an ATS request path: a handler
// that throws only fails that event's dispatch (retried with backoff, then
// quarantined) and can never touch the committed ATS write.
//
// Delivery is AT-LEAST-ONCE and an event is re-dispatched to EVERY handler on a
// retry, so every handler MUST be idempotent (keyed on envelope.event_id or on
// its own natural key). A handler must also tolerate a Talent that no longer
// exists (an erased record's earlier events may still be in flight).
export type AtsTalentEventEnvelope = AramoEventEnvelope<TalentEventPayload>;

export interface AtsTalentEventHandler {
  // Stable name for logs / the dispatch failure reason.
  readonly name: string;
  handle(event: AtsTalentEventEnvelope): Promise<void>;
}

// EXTENSION POINT — the ordered handler list the dispatcher fans out to. It is
// bound in AtsTalentEventsModule as a factory over the concrete handler
// classes; ATI-SEP-1 T8 adds the Intelligence publisher (entitlement check →
// allowlisted ingest call) by appending it to that factory's `inject` list.
// The LEGACY handler is TEMPORARY and is removed at T10.
export const ATS_TALENT_EVENT_HANDLERS = 'ATS_TALENT_EVENT_HANDLERS';
