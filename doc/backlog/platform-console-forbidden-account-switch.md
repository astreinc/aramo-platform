# UX backlog — "You don't have permission" page: show the signed-in account + offer account switch

Status: OPEN — optional UX improvement; not scheduled. Needs a filed directive before implementation.
Raised: 2026-10-22, from a PO sign-in mix-up on admin.aramo.ai (not a defect).

## What happened

The PO was signed in to the Astre tenant (`purush@astreinc.com`) in one browser tab,
then opened admin.aramo.ai in another tab. The identity provider's existing browser
session was reused silently, so the platform console signed in as the Astre identity.
That identity's only membership is the Astre tenant (one user, one tenant — IC-1), so
the session carried no `platform:*` scopes and the console showed:

> You don't have permission — This page requires the platform:tenant:read scope, which
> is not granted to your account.

Closing the browser and signing in fresh as the platform operator (`purush@aramo.ai`)
worked. Nothing is broken; the page just doesn't make the cause visible.

## Proposed improvement

On the "You don't have permission" page:

1. Show **which account is signed in** (email / display name from the session), so a
   wrong-account sign-in is obvious at a glance.
2. Offer **"Sign in with a different account"**, reusing the existing account-switch
   path — `SignedOut` already does this via `offerAccountSwitch` →
   `redirectToLogin({ selectAccount: true })`
   (`libs/fe-foundation/src/components/SignedOut.tsx`).

## Where it lands

- `libs/fe-foundation/src/components/ForbiddenState.tsx` — the shared forbidden page
  (used by platform-web's app-level gate through `RouteGuard`,
  `libs/fe-foundation/src/auth/RouteGuard.tsx`, and by the per-route
  `ForbiddenState scope="platform:skill:read"` gates in `apps/platform-web/src/App.tsx`).
- It is a shared component, so the change can be opt-in (a prop, like
  `offerAccountSwitch`) to avoid changing other apps' forbidden pages unintentionally.

## Workaround until then

Use a separate browser profile, or a fresh private window, for admin.aramo.ai.

## Related (separate decision, not part of this item)

Platform sessions bound to a non-platform tenant are only logged, not refused, while
`AUTH_HOST_TENANT_BINDING=log`
(`apps/auth-service/src/app/auth/identity-principal-directory.adapter.ts`, host-binding
check). Enforcing it for the platform host would refuse sign-in instead of showing the
forbidden page — that needs its own Lead ruling.
