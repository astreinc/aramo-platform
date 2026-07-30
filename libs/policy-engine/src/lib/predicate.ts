import type { PolicyContext, Predicate, PredicateSource } from './types.js';

// The generic predicate machine. A rule's condition is DATA: a list of
// predicates the engine applies mechanically. The engine knows the OPERATORS
// (eq, lte, in, …) — never the meaning of a `key`. This is what keeps the
// evaluator domain-agnostic while a data-authored rule keys on any declared or
// derived fact, an attribute, or a resolved capability.

function bucket(
  ctx: PolicyContext,
  source: PredicateSource,
): Readonly<Record<string, unknown>> {
  switch (source) {
    case 'declared':
      return ctx.resource_state.declared;
    case 'derived':
      return ctx.resource_state.derived;
    case 'attributes':
      return ctx.attributes;
    case 'capabilities':
      return ctx.principal_capabilities;
  }
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function evalPredicate(ctx: PolicyContext, p: Predicate): boolean {
  const store = bucket(ctx, p.source);
  const has = Object.prototype.hasOwnProperty.call(store, p.key);
  const actual = has ? store[p.key] : undefined;

  switch (p.op) {
    case 'exists':
      return has;
    case 'eq':
      return has && Object.is(actual, p.value);
    case 'ne':
      // A missing key is "not equal" to any concrete expected value.
      return !has || !Object.is(actual, p.value);
    case 'in':
      return (
        has && Array.isArray(p.value) && p.value.some((x) => Object.is(x, actual))
      );
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const a = asNumber(actual);
      const b = asNumber(p.value);
      if (a === null || b === null) return false; // non-numeric → predicate fails
      if (p.op === 'lt') return a < b;
      if (p.op === 'lte') return a <= b;
      if (p.op === 'gt') return a > b;
      return a >= b;
    }
  }
}

// A rule's condition holds iff EVERY predicate holds (logical AND). Absent /
// empty condition = always applies to its (resource, action).
export function conditionHolds(
  ctx: PolicyContext,
  when: readonly Predicate[] | undefined,
): boolean {
  if (when === undefined || when.length === 0) return true;
  return when.every((p) => evalPredicate(ctx, p));
}
