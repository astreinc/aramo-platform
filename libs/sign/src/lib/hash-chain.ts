import { createHash } from 'node:crypto';

// DOC-3 R20/§256 — tamper-evident SignatureEvent hash chain. Each event's hash
// is sha256 over (previous_event_hash || canonical event core). The terminal
// event's hash is the envelope's event-chain hash, fed into the evidence
// manifest (R19). Deterministic: JSON.stringify of a fixed field order.
//
// Retention and Purge directive (ebd41d99) LD-2 — the payload is hashed with its object
// keys in PostgreSQL jsonb order (shorter keys first, then bytewise), recursively. The
// payload column is jsonb, which stores keys in that order, so an event read back from the
// database recomputes to its stored hash. Before this, a multi-key payload was hashed in
// the writer's key order and could not be recomputed from the stored row (see
// verifyEventChain: LINK_ONLY). A payload whose keys were already in jsonb order hashes
// exactly as before, and no stored hash is ever rewritten.

export interface EventHashInput {
  envelope_id: string;
  event_type: string;
  actor_type: string;
  actor_ref: string | null;
  payload: unknown;
  occurred_at: string; // ISO
}

function jsonbKeyCompare(a: string, b: string): number {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length - bb.length || Buffer.compare(ab, bb);
}

/** The value with every object's keys in PostgreSQL jsonb storage order (recursive). */
export function jsonbCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbCanonical);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort(jsonbKeyCompare)) {
      if (obj[k] !== undefined) out[k] = jsonbCanonical(obj[k]);
    }
    return out;
  }
  return value;
}

export function computeEventHash(previousHash: string | null, core: EventHashInput): string {
  const canonical = JSON.stringify({
    previous: previousHash,
    envelope_id: core.envelope_id,
    event_type: core.event_type,
    actor_type: core.actor_type,
    actor_ref: core.actor_ref,
    payload: jsonbCanonical(core.payload ?? null),
    occurred_at: core.occurred_at,
  });
  return createHash('sha256').update(canonical).digest('base64url');
}

// LD-2 — chain verification that never weakens silently. Every event's previous_event_hash
// must equal the prior event's stored hash (the link). Per event:
//   VERIFIED            the hash recomputes from the stored row
//   REDACTED_ATTESTED   personal data removed by a purge (recompute impossible by design);
//                       stored hash equals the hash recorded at redaction, and the event
//                       recomputed before redaction
//   REDACTED_LINK_ONLY  as above, but the event could not be recomputed before redaction
//                       (a pre-change multi-key payload, see below)
//   LINK_ONLY           not redacted, link intact, but the hash does not recompute from the
//                       stored payload: an event written before the jsonb-order change whose
//                       payload keys were not in jsonb order. Reported, never counted VERIFIED.
//   BROKEN              a link break, or a redaction record that does not match the event
// ok is true only when nothing is BROKEN; every other status is counted explicitly.

export interface ChainEventRow extends EventHashInput {
  id: string;
  previous_event_hash: string | null;
  event_hash: string;
}

export interface ChainRedactionRow {
  event_id: string;
  original_event_hash: string;
  verified_before_redaction: boolean;
}

export type ChainEventStatus = 'VERIFIED' | 'REDACTED_ATTESTED' | 'REDACTED_LINK_ONLY' | 'LINK_ONLY' | 'BROKEN';

export interface ChainVerification {
  ok: boolean;
  verified: number;
  redacted_attested: number;
  redacted_link_only: number;
  link_only: number;
  broken: Array<{ event_id: string; reason: 'link' | 'redaction_record' }>;
  statuses: Array<{ event_id: string; status: ChainEventStatus }>;
}

/** `events` in chain order (occurred_at, id). */
export function verifyEventChain(events: readonly ChainEventRow[], redactions: readonly ChainRedactionRow[]): ChainVerification {
  const byEvent = new Map(redactions.map((r) => [r.event_id, r]));
  const out: ChainVerification = { ok: true, verified: 0, redacted_attested: 0, redacted_link_only: 0, link_only: 0, broken: [], statuses: [] };
  let prior: string | null = null;
  for (const ev of events) {
    let status: ChainEventStatus;
    const linked = ev.previous_event_hash === prior;
    if (!linked) out.broken.push({ event_id: ev.id, reason: 'link' });
    const redaction = byEvent.get(ev.id);
    if (computeEventHash(ev.previous_event_hash, ev) === ev.event_hash) {
      status = 'VERIFIED';
      out.verified += 1;
    } else if (redaction !== undefined) {
      if (redaction.original_event_hash !== ev.event_hash) {
        status = 'BROKEN';
        out.broken.push({ event_id: ev.id, reason: 'redaction_record' });
      } else if (redaction.verified_before_redaction) {
        status = 'REDACTED_ATTESTED';
        out.redacted_attested += 1;
      } else {
        status = 'REDACTED_LINK_ONLY';
        out.redacted_link_only += 1;
      }
    } else {
      status = 'LINK_ONLY';
      out.link_only += 1;
    }
    out.statuses.push({ event_id: ev.id, status: linked ? status : 'BROKEN' });
    prior = ev.event_hash;
  }
  out.ok = out.broken.length === 0;
  return out;
}
