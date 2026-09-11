# Backlog — Add Talent: consent capture (revisit)

**Status:** DEFERRED (PO ruling, 2026-09-11). Removed from the Add-Talent
create flow to match the updated résumé-first prototype
(`design/aramo-prototype/platform/Talent.dc.html`), whose footer states:
"Contact permissions are governed separately from profile creation ·
provenance is recorded automatically."

## What was removed
The Add-Talent full-page create flow previously captured the 5-scope consent
model (`profile_storage`, `resume_processing`, `matching`, `contacting`,
`cross_tenant_visibility`) + the R7 attestation, and **gated the save** on the
two required scopes + the attestation. That in-form capture + save-gate is
removed; talent creation no longer blocks on consent.

## Why this is now unblocked (not a keying HALT)
The earlier "consent is Core-keyed" blocker was **stale** and was corrected in
the Core-Talent cleanup (#779): the consent ledger
(`consent.TalentConsentEvent`) is keyed on `talent_record_id`, which the new
record has at create. So a grant CAN be keyed correctly at create — the reason
it is not fired here now is a **product decision** (permissions governed
separately), not a technical blocker. [[project_talent_admission_invariant]]

## To revisit
- Whether/where contact-permission consent is captured (a dedicated
  post-create step, the Talent Detail consent surface, or re-introduced into
  Add Talent) and when `POST /v1/consent/grant` (keyed on `talent_record_id`)
  fires.
- Reconcile with the governed-LLM résumé-extraction path, which is gated on
  `ai_processing` consent (fail-closed) — that consent path needs a home.
- The R7 attestation ("consent to represent obtained") — where it lives once
  in-form capture is gone.

## Pointers
- Prototype: `design/aramo-prototype/platform/Talent.dc.html` (Add-Talent panel).
- Consent scopes: `libs/consent` `CONSENT_SCOPES`; grant route `POST /v1/consent/grant`.
- FE model retained for reuse: `apps/ats-web/src/talent/consent.ts`,
  `ConsentCapture.tsx` (no longer imported by the create flow).
