import { randomUUID } from 'node:crypto';

import type { SignNotificationType } from './notification-kinds.js';

// Aramo Sign Mobile — the notification fan-out SOURCE (M-A3 §1 "durable, idempotent
// events"; directive §8 "Fan-out"). A notifiable signing fact is recorded as a
// SignNotificationOutbox row IN THE SAME transaction as its ledger event
// (EsignRepository.appendEvent calls recordNotificationFact), so it commits with the
// state change or not at all. The sign-service fan-out worker turns each row into
// feed rows and push jobs; the ledger itself is never replayed.
//
// Routine create / attach / send-side events are not notifiable, except that a
// send is the moment a signer's signature becomes needed (the worker only notifies
// recipients who have claimed the envelope in their inbox).

const LEDGER_TO_NOTIFICATION: Readonly<Record<string, SignNotificationType>> = {
  SESSION_EXCHANGED: 'VIEWED',
  SIGNER_SIGNED: 'SIGNED',
  ENVELOPE_DECLINED: 'DECLINED',
  ENVELOPE_COMPLETED: 'COMPLETED',
  ENVELOPE_EXPIRED: 'EXPIRED',
  ENVELOPE_SENT: 'SIGNATURE_NEEDED',
  SIGNATURE_REMINDER_SENT: 'REMINDER',
};

export function notificationKindForLedgerEvent(event_type: string): SignNotificationType | null {
  return LEDGER_TO_NOTIFICATION[event_type] ?? null;
}

export interface NotificationFactInput {
  tenant_id: string;
  envelope_id: string;
  signer_id?: string | null;
  event_type: string;
  actor_type: string;
  actor_ref?: string | null;
  // The ledger payload. A REMINDER's payload names the signers it went to
  // ({ signer_ids }); nothing else is read from it.
  payload?: unknown;
}

function reminderTargets(payload: unknown): string[] {
  const ids = (payload as { signer_ids?: unknown } | null | undefined)?.signer_ids;
  return Array.isArray(ids) ? ids.filter((s): s is string => typeof s === 'string') : [];
}

interface NotificationOutboxDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Record the fact on the caller's transaction client. Returns the outbox row id, or
// null when the event is not notifiable. A client without the delegate (a unit-test
// double of the transaction) records nothing.
export async function recordNotificationFact(tx: unknown, input: NotificationFactInput): Promise<string | null> {
  const kind = notificationKindForLedgerEvent(input.event_type);
  if (kind === null) return null;
  const delegate = (tx as { signNotificationOutbox?: NotificationOutboxDelegate } | null)?.signNotificationOutbox;
  if (delegate === undefined || typeof delegate.create !== 'function') return null;
  const id = randomUUID();
  const signer = kind === 'DECLINED' ? (input.signer_id ?? input.actor_ref ?? null) : (input.signer_id ?? null);
  await delegate.create({
    data: {
      id,
      tenant_id: input.tenant_id,
      envelope_id: input.envelope_id,
      signer_id: signer !== null && UUID.test(signer) ? signer : null,
      kind,
      actor_type: input.actor_type,
      actor_ref: input.actor_ref !== undefined && input.actor_ref !== null && UUID.test(input.actor_ref) ? input.actor_ref : null,
      signer_ids: kind === 'REMINDER' ? reminderTargets(input.payload).filter((s) => UUID.test(s)) : [],
    },
  });
  return id;
}
