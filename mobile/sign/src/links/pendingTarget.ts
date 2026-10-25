// The deep-link target kept while the user signs in (handoff §4.1: "When the session
// expires, return here and keep the deep-link target"). Memory only; only
// authenticated targets (envelope / inbox-sign) are kept — never capability tokens.
import type { LinkRoute } from './routeLink';

type Target = Extract<LinkRoute, { kind: 'envelope' | 'inbox-sign' }>;
let pending: Target | null = null;

export function setPendingTarget(t: Target): void {
  pending = t;
}

export function takePendingTarget(): Target | null {
  const t = pending;
  pending = null;
  return t;
}
