import { createContext, useContext, type ReactNode } from 'react';

// RTR execution access (PO ruling 2026-10-18): sending an RTR for signature
// requires BOTH
//   - the user's permissions: document:create (create the RTR document) AND
//     document:execute (send it / remind), and
//   - the tenant's Aramo Sign subscription (the `esign` capability).
// The backend enforces both (RtrController: EntitlementGuard + RequireScopes);
// this module only decides whether the ATS shows the actions, so a user never
// sees a button the backend will refuse.
//
// The subscription comes from the SAME backend-authoritative availability read
// as App Home and the app switcher (GET /v1/me/products → esign.subscribed),
// provided once by the recruiter shell. Unknown (loading, error, no provider)
// is treated as not subscribed: the actions stay hidden rather than offered.

export const RTR_REQUEST_SCOPE = 'document:create';
export const RTR_EXECUTE_SCOPE = 'document:execute';

const SignSubscriptionContext = createContext<boolean | null>(null);

export function SignSubscriptionProvider({ subscribed, children }: { readonly subscribed: boolean | null; readonly children: ReactNode }): JSX.Element {
  return <SignSubscriptionContext.Provider value={subscribed}>{children}</SignSubscriptionContext.Provider>;
}

/** True only when the tenant is known to hold the Aramo Sign subscription. */
export function useSignSubscribed(): boolean {
  return useContext(SignSubscriptionContext) === true;
}

/** Send RTR: both document permissions + the Sign subscription. */
export function canSendRtr(scopes: readonly string[], signSubscribed: boolean): boolean {
  return signSubscribed && scopes.includes(RTR_REQUEST_SCOPE) && scopes.includes(RTR_EXECUTE_SCOPE);
}

/** Send an already-requested RTR, or remind: document:execute + the Sign subscription. */
export function canExecuteRtr(scopes: readonly string[], signSubscribed: boolean): boolean {
  return signSubscribed && scopes.includes(RTR_EXECUTE_SCOPE);
}
