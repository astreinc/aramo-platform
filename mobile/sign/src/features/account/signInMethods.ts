// Account → Sign-in methods (Apple Go-Live A1 L-3 path 1, L-4, L-7). The signed-in user's
// linked providers come from auth-service with the app's Bearer token:
//   GET    /auth/me/sign-in-methods?consumer=sign          -> {items: [{idp, email_snapshot, linked_at}]}
//   DELETE /auth/me/sign-in-methods/{idp}?consumer=sign    -> 204 | 409 last_sign_in_method
//   POST   /auth/native/sign/link   (the token body)        -> {linked: true, idp}
// Adding a provider is proof (c): the user is signed in when the link starts. The server
// applies the attach policy (L-5) and sends the security email; the app renders its answer.
import type {
  LinkedResponse,
  SignInMethod,
  SignInMethodsResponse,
} from '../../api/apple-contract-types';
import type { WorkspaceClient } from '../../api/workspaceClient';
import { isProvider, PROVIDER_NAMES, type Provider } from '../../auth/authorize';
import type { CodeExchange } from '../../auth/nativeAuthApi';
import { validatedLinked } from '../../auth/nativeAuthApi';

/** The consumer the sign-in methods routes are asked about (shared build contract). */
export const SIGN_IN_METHODS_CONSUMER = 'sign';

export const signInMethodKeys = { all: ['auth', 'me', 'sign-in-methods'] as const };

/** Order on screen and in the Add list (Apple Go-Live login-options order). */
export const PROVIDER_ORDER: readonly Provider[] = ['microsoft', 'google', 'apple'];

export async function loadSignInMethods(workspace: WorkspaceClient): Promise<SignInMethod[]> {
  const r = await workspace.request<SignInMethodsResponse>({
    method: 'GET',
    path: '/auth/me/sign-in-methods',
    query: { consumer: SIGN_IN_METHODS_CONSUMER },
  });
  const items = Array.isArray(r.data?.items) ? r.data.items : [];
  return items
    .filter((m) => isProvider(m.idp))
    .sort((a, b) => PROVIDER_ORDER.indexOf(a.idp) - PROVIDER_ORDER.indexOf(b.idp));
}

export async function removeSignInMethod(workspace: WorkspaceClient, idp: Provider): Promise<void> {
  await workspace.request<unknown>({
    method: 'DELETE',
    path: `/auth/me/sign-in-methods/${idp}`,
    query: { consumer: SIGN_IN_METHODS_CONSUMER },
  });
}

/** POST /auth/native/sign/link with the Bearer token (A1 L-4 path 1, native). */
export function linkWithWorkspace(
  workspace: WorkspaceClient,
): (body: CodeExchange) => Promise<LinkedResponse> {
  return async (body) =>
    validatedLinked(
      (await workspace.request<unknown>({ method: 'POST', path: '/auth/native/sign/link', body }))
        .data,
    );
}

/** Providers the user could still add (one link per provider; the server decides the rest). */
export function addableProviders(methods: readonly SignInMethod[]): Provider[] {
  const linked = new Set(methods.map((m) => m.idp));
  return PROVIDER_ORDER.filter((p) => !linked.has(p));
}

export const SIGN_IN_METHODS_COPY = {
  title: 'Sign-in methods',
  intro: 'Ways you can sign in to this account.',
  add: (p: Provider) => `Add ${PROVIDER_NAMES[p]}`,
  remove: 'Remove',
  added: (p: Provider) => `${PROVIDER_NAMES[p]} was added. You can now sign in with it.`,
  removed: (p: Provider) => `${PROVIDER_NAMES[p]} was removed.`,
  removeTitle: (p: Provider) => `Remove ${PROVIDER_NAMES[p]}?`,
  removeBody: (p: Provider) =>
    `You won’t be able to sign in with ${PROVIDER_NAMES[p]} any more. Your ${PROVIDER_NAMES[p]} account itself is not affected.`,
  loadFailed: 'Couldn’t load your sign-in methods.',
  failed: 'Couldn’t change your sign-in methods. Try again.',
} as const;
