// Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED §3.6 — Sign lifecycle event
// types are named `sign.*`. Rows written before the rename keep their historical
// `esign.*` name (history is never rewritten), so every comparison goes through
// this function: a redelivered historical event routes and verifies exactly like
// its renamed equivalent.
const HISTORICAL_PREFIX = 'esign.';

export function canonicalSignEventType(eventType: string): string {
  return eventType.startsWith(HISTORICAL_PREFIX) ? `sign.${eventType.slice(HISTORICAL_PREFIX.length)}` : eventType;
}
