# Platform Admin and Template Studio: handoff amendment 1

**Applies to:** `handoff/Platform Admin and Template Studio - Claude Code handoff.md`. The handoff has been updated in place. This file lists the changes, so they can be reviewed and LOCKED without re-reading the full handoff.

**Source:** Claude Code's review of the handoff against the code at `45d30da9`.

**Authority:** for the items below, this amendment wins over the design files (`platform/*.dc.html`).

## Would break
| # | Change | Handoff § |
|---|---|---|
| 1 | Platform admins route is **`/admins`**, not `/platform/admins`. Nginx proxies every `/platform/` path on admin.aramo.ai to the backend (`aramo.conf.template:180`). | §4, §9 |
| 2 | **Keep `/login`**; don't rename it to `/signin`. The auth-service redirects failures to `/login?error=CODE` (`auth.controller.ts:540`). Map the **existing** codes handled in `SignInPage.tsx:157-173` (e.g. `TENANT_ACCESS_DENIED`) to the designed copy. Drop the invented `wrong_account`, `session_expired` and `provider_error`. | §1, §4, §11 |
| 3 | The Sign Personal **review queue requires `platform:tenant:lifecycle:manage`** to read (`platform-personal.controller.ts:42`). Hide the nav item without it. There is no view-only state for this screen. | §2, §3.3, §8.1 |

## Invented or missing data
| # | Change | Handoff § |
|---|---|---|
| 4 | Tenant user invite errors are `VALIDATION_ERROR`, `EMAIL_UNAVAILABLE` and `INVITATION_ALREADY_EXISTS`. `ROLE_COMBINATION_REFUSED` does not exist: refused role combinations come back as `VALIDATION_ERROR`, so show the server message. | §6.3 |
| 5 | Remove "N of 50 pilot seats used". It has no read endpoint; the cap only appears as `personal_pilot_full`. Added to Data gaps. | §8.2, §14 |
| 6 | The `@aramo.ai` email rule for platform admins is **not enforced by the backend**. It's a PRODUCT DECISION; don't ship the client-side check until that decision is made. | §9 |
| 7 | Confirm these labels against the real enum values before shipping, and use the real values where they differ: alias types, relationship sources, skill version states, review-queue "first seen", registry "aliases" / "updated" columns, and the template "Start from a copy" option. Added to Data gaps. | §9, §10.1, §14 |

## Conflicts with LOCKED rulings and existing code
| # | Change | Handoff § |
|---|---|---|
| 8 | Template editor: **reuse the in-house block editor** in `libs/document-templates-web` (`dt-block-editor.tsx`, `RtrDraftEditor.tsx`). The repo has no rich-text dependency, and adding one (TipTap, Lexical, Slate) needs a separate decision. The allowed-content schema, `{{key}}` serialisation and round-trip tests still apply. | §10.4 |
| 9 | `fe-foundation/src/components` is frozen (DDR v1.2 §6). Don't add variants to `InlineAlert` or `Tag`. Build the view-only note, the info/warning alerts and the PLATFORM marker locally in platform-web. The `src/ui` changes (midnight rail theme, StatusPill `muted` tone) go in their **own PR**, with platform-web regression coverage. | §3.6, §12 |
| 10 | Rail collapse uses AppShell's existing `RAIL_COLLAPSE_KEY`. Don't add `aramo.platform.rail`; that key is prototype-only. | §3.3 |
| 11 | Run all copy through `scripts/verify-vocabulary.sh`. One change already made: "evidence, not a rating" is now "N risk points from recorded signals". | §8.1 |

## Verified against the repo (`astreinc/aramo-platform@main`, 24 Oct 2026)
- **Confirmed:**
  - #2: `SignInPage.tsx`, `session.ts`, `TENANT_ACCESS_DENIED_PATH`.
  - #3: `platform-personal.controller.ts:42`; `App.tsx` already gates `/personal-review` on lifecycle:manage.
  - #4: `platform-invitation.service.ts`.
  - #5: `personal_pilot_full`, with the cap in error details only.
  - #8: `dt-block-editor.tsx`.
  - #10: the key is `rc-rail-collapsed`.
- **Not verified:** #1. The nginx template isn't readable through the import, so take the line reference from Claude Code's review.

## Added after the repo check
| # | Change | Handoff § |
|---|---|---|
| 12 | **Keep the existing routes** in `apps/platform-web/src/App.tsx`: `/document-templates`, `/document-templates/:id`, `/template-variables`, `/personal-review`, `/personal-invites`, `/skills/proposals/:id`. The Template Studio **replaces** the view at `/document-templates/:id`. Tenant tabs use a `?tab=` query param, not new path segments. | §4 |
| 13 | The tenant **Domain tab needs `platform:tenant:lifecycle:manage` for reads too** (`platform.controller.ts:348`, "for all five, reads included"). Without it, hide the tab rather than showing view-only. | §2, §6.3 |
| 14 | Sign-in copy goes through `SignInPage`'s existing `errorCopy` prop, keyed by the real codes: `TENANT_ACCESS_DENIED` (and its `idp_not_permitted_for_tenant` reason), `INSUFFICIENT_PERMISSIONS`, `TENANT_CAPABILITY_NOT_ENTITLED`, `TENANT_SUSPENDED`, `TENANT_CLOSED`, `VALIDATION_ERROR` and `INTERNAL_ERROR`. No edits to SignInPage. | §11 |
| 15 | Unscoped routes keep the existing `ForbiddenState scope=…` pattern, restyled to §3.5. | §3.5 |

## Design files updated to match
`platform/Platform Admin.dc.html` now has:
- the review queue gated by `lifecycle:manage`
- `VALIDATION_ERROR` copy for tenant user invites
- no pilot seat count
- the new signals header
- `TENANT_ACCESS_DENIED` as the wrong-account example

## Next step
The Lead drafts a directive that adopts the handoff plus this amendment, and LOCKS it. Implementation then starts on a dedicated branch.
