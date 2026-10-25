// Hands an auth callback URL that arrives as a deep link (Android App Link, or an iOS
// universal link outside the auth session) to the sign-in attempt waiting for it. One
// attempt at a time; a URL with no waiting attempt is dropped (never stored).
import { isCallbackFor } from './authorize';

interface Waiter {
  readonly redirectUri: string;
  readonly resolve: (url: string) => void;
}

let waiter: Waiter | null = null;

export function expectCallback(redirectUri: string): {
  promise: Promise<string>;
  cancel: () => void;
} {
  let resolveFn: (url: string) => void = () => undefined;
  const promise = new Promise<string>((resolve) => {
    resolveFn = resolve;
  });
  const own: Waiter = { redirectUri, resolve: resolveFn };
  waiter = own;
  return {
    promise,
    cancel: () => {
      if (waiter === own) waiter = null;
    },
  };
}

/** Returns true when a waiting sign-in consumed the URL. */
export function deliverCallback(url: string): boolean {
  const w = waiter;
  if (!w || !isCallbackFor(url, w.redirectUri)) return false;
  waiter = null;
  w.resolve(url);
  return true;
}
