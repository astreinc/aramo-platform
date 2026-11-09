import { apiClient } from '../api/client';

import { getAuthConsumer } from './consumer';
import type { FederatedIdp } from './session';

// Apple Go-Live A1 (Proven Account Linking) — the web side of the three linking
// paths (A1 L-3) and the signed-in Sign-in methods list (A1 L-4/L-7):
//
//   - The /login error redirect carries a pending-link handle in the URL
//     FRAGMENT (`#link=<handle>&idp=<idp>`, A1 L-2). Fragments never reach a
//     server or a log; the page reads it once, keeps it in memory only and
//     strips it from the address bar.
//   - Proof (b): an email code (`/auth/link/email/start` + `/verify`), no
//     session needed. Proof (a) rides the normal login with `link=<handle>`.
//   - Path 1 (signed in): `/auth/<consumer>/link?idp=<p>&return=<path>`.

export const FEDERATED_IDPS: readonly FederatedIdp[] = ['microsoft', 'google', 'apple'];

export const PROVIDER_NAME: Record<FederatedIdp, string> = {
  microsoft: 'Microsoft',
  google: 'Google',
  apple: 'Apple',
};

export function isFederatedIdp(v: unknown): v is FederatedIdp {
  return typeof v === 'string' && (FEDERATED_IDPS as readonly string[]).includes(v);
}

export interface PendingLink {
  handle: string;
  idp: FederatedIdp;
}

/** `#link=<handle>&idp=<idp>` → the pending link, or null. The handle is opaque (base64url). */
export function parseLinkFragment(hash: string | null | undefined): PendingLink | null {
  if (hash === null || hash === undefined || hash.length < 2) return null;
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const handle = params.get('link');
  const idp = params.get('idp');
  if (handle === null || !/^[A-Za-z0-9_-]{16,256}$/.test(handle) || !isFederatedIdp(idp)) return null;
  return { handle, idp };
}

export type LinkEmailFailure =
  | { reason: 'code_invalid'; attemptsRemaining: number | null }
  | { reason: 'code_expired' | 'code_attempts_exceeded' | 'link_expired' | 'failed' };

export type LinkEmailVerifyResult = { ok: true; idp: FederatedIdp | null } | ({ ok: false } & LinkEmailFailure);

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

/** Proof (b), step 1 — always 202 on the server (no enumeration oracle); true when the request went out. */
export async function startLinkEmail(linkHandle: string, email?: string): Promise<boolean> {
  try {
    const res = await fetch('/auth/link/email/start', {
      method: 'POST',
      credentials: 'same-origin',
      headers: JSON_HEADERS,
      body: JSON.stringify(email !== undefined ? { link_handle: linkHandle, email } : { link_handle: linkHandle }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Proof (b), step 2 — 200 `{linked, idp}` or a typed refusal. */
export async function verifyLinkEmail(linkHandle: string, code: string): Promise<LinkEmailVerifyResult> {
  try {
    const res = await fetch('/auth/link/email/verify', {
      method: 'POST',
      credentials: 'same-origin',
      headers: JSON_HEADERS,
      body: JSON.stringify({ link_handle: linkHandle, code }),
    });
    const body = (await res.json().catch(() => null)) as
      | { linked?: unknown; idp?: unknown; error?: { details?: { reason?: unknown; attempts_remaining?: unknown } } }
      | null;
    if (res.ok && body?.linked === true) return { ok: true, idp: isFederatedIdp(body.idp) ? body.idp : null };
    const reason = body?.error?.details?.reason;
    if (reason === 'code_invalid') {
      const left = body?.error?.details?.attempts_remaining;
      return { ok: false, reason, attemptsRemaining: typeof left === 'number' ? left : null };
    }
    if (reason === 'code_expired' || reason === 'code_attempts_exceeded' || reason === 'link_expired') return { ok: false, reason };
    return { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

// ── Sign-in methods (A1 L-4 "Methods", L-7 account settings) ─────────────────

export interface SignInMethod {
  idp: FederatedIdp;
  email_snapshot: string | null;
  linked_at: string;
}

const methodsPath = (consumer: string, idp?: FederatedIdp) =>
  `/auth/me/sign-in-methods${idp !== undefined ? `/${idp}` : ''}?consumer=${encodeURIComponent(consumer)}`;

export async function fetchSignInMethods(consumer: string = getAuthConsumer()): Promise<SignInMethod[]> {
  const body = await apiClient.get<{ items?: unknown }>(methodsPath(consumer));
  const items = Array.isArray(body?.items) ? (body.items as Array<Partial<SignInMethod>>) : [];
  return items
    .filter((m): m is SignInMethod => isFederatedIdp(m.idp))
    .map((m) => ({ idp: m.idp, email_snapshot: typeof m.email_snapshot === 'string' ? m.email_snapshot : null, linked_at: String(m.linked_at ?? '') }));
}

/** Rejects with ApiError; a 409 `last_sign_in_method` means the last method can't be removed. */
export async function removeSignInMethod(idp: FederatedIdp, consumer: string = getAuthConsumer()): Promise<void> {
  await apiClient.delete<unknown>(methodsPath(consumer, idp));
}

/** Path 1 (A1 L-3/L-4) — add a provider while signed in; the callback returns to `returnPath?linked=<p>` or `?link_error=<reason>`. */
export function linkProviderUrl(idp: FederatedIdp, returnPath: string, consumer: string = getAuthConsumer()): string {
  const params = new URLSearchParams({ idp, return: returnPath });
  return `/auth/${consumer}/link?${params.toString()}`;
}

/** Plain-language copy for the attach refusals (A1 L-5) and the link-flow errors; `provider` null = not known. */
export function linkRefusalMessage(reason: string | null, provider: string | null): string {
  switch (reason) {
    case 'identity_already_linked':
      return `${provider !== null ? `That ${provider} account` : 'That account'} is already connected to a different Aramo account.`;
    case 'idp_already_linked':
      return provider !== null
        ? `Your account already has a ${provider} sign-in. Remove it first to connect a different one.`
        : 'Your account already has a sign-in with that provider. Remove it first to connect a different one.';
    case 'idp_not_permitted_for_tenant':
      return `${provider ?? 'That provider'} can’t be used to sign in to this account.`;
    case 'user_inactive':
      return 'This Aramo account isn’t active, so a sign-in method can’t be added.';
    case 'link_expired':
      return `The request to connect ${provider ?? 'the account'} expired. Try again.`;
    default:
      return `We couldn’t connect ${provider ?? 'the account'}. Try again.`;
  }
}
