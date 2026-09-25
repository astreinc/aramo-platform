import { createHash } from 'node:crypto';

// DOC-3 R20/§256 — tamper-evident SignatureEvent hash chain. Each event's hash
// is sha256 over (previous_event_hash || canonical event core). The terminal
// event's hash is the envelope's event-chain hash, fed into the evidence
// manifest (R19). Deterministic: JSON.stringify of a fixed field order.

export interface EventHashInput {
  envelope_id: string;
  event_type: string;
  actor_type: string;
  actor_ref: string | null;
  payload: unknown;
  occurred_at: string; // ISO
}

export function computeEventHash(previousHash: string | null, core: EventHashInput): string {
  const canonical = JSON.stringify({
    previous: previousHash,
    envelope_id: core.envelope_id,
    event_type: core.event_type,
    actor_type: core.actor_type,
    actor_ref: core.actor_ref,
    payload: core.payload ?? null,
    occurred_at: core.occurred_at,
  });
  return createHash('sha256').update(canonical).digest('base64url');
}
