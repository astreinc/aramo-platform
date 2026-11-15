# Aramo — CCP Refund Execution Release Directive v1.0 (LOCKED)

**Status:** LOCKED — ratified by the PO 2026-11-15 (fast track). **Date:** 2026-11-15. **Baseline:** origin/main `6ed4a614` (in production; Stripe live since 2026-11-15).
**Trigger:** PO 2026-11-15 — make refunds possible from the console instead of the Stripe Dashboard.
**Governing instruments:** `Aramo-CCP-Charter-Amendment-A2-Refund-Execution-Policy-Keys-v1_0-LOCKED` (RX-1…RX-11); `Aramo-CCP-Program-Build-Directive-Amendment-A1-Commercial-Action-Catalog-v1_0-LOCKED` RF-8; refund policy `ARAMO-COM-REFUND-POL-001` (draft revision 3, 2026-11-15).

## 1. What already exists (substrate, origin/main 6ed4a614)
- The three policy keys `refund_execution_enabled`, `refund_policy_ref`, `refund_policy_sha256` are parsed and validated (`libs/subscription/src/lib/commercial/commercial-policy.ts:38`, `:156-158`).
- Gate 1 reads `CCP_REFUND_EXECUTION_ENABLED` (`libs/subscription/src/lib/commercial/commercial-billing-adjustment.ts:35-37`); gate 2 and RX-8 are implemented (`libs/subscription/src/lib/commercial/refund-execution-gate.ts`).
- The dark-state runbook already checks gate 1 on platform-admin and sign-service (`doc/runbooks/RUNBOOK-ccp-dark-state-verification.md:87-88`).
- The live Stripe refund path (invoice payments → payment intent → refund) passed the test-mode E2E at `2026-09-30.endive` (report 2026-11-15, step 15).

## 2. What is missing
| # | Gap | Owner |
|---|---|---|
| G-1 | `docker-compose.prod.yml` does not pass `CCP_REFUND_EXECUTION_ENABLED` to platform-admin or sign-service, so gate 1 cannot be set in production even with the PO's release authorization | Engineering |
| G-2 | No approved refund policy: RX-3 needs Finance, **Legal counsel** and Platform Owner approval, filed `…-LOCKED.md` in `Aramo/locked/` with a `.sha256` sidecar. Internal approval does not satisfy Legal | Finance, counsel, PO |
| G-3 | No ACTIVE commercial policy version carries the three keys | Finance → Owner (console) |
| G-4 | Gate 1 is not set in production | PO release authorization |

## 3. Work (in order)
1. **Code (one PR, `feat/ccp-refund-gate-passthrough`):** add `CCP_REFUND_EXECUTION_ENABLED` to the `environment:` list of `platform-admin` and `sign-service` in `docker-compose.prod.yml` (pass-through, no default); document it in `.env.prod.example` as "unset = refunds disabled (gate 1, Charter A2 RX-5)". No application code change. Full CI.
2. **Deploy** the PR to production with the variable **unset** (behaviour unchanged). Verify with the dark-state runbook: gate 1 reads unset on both services.
3. **Refund policy approval (G-2):** Finance, counsel and the PO review revision 3, settle RP-01…RP-22, sign the §19 approval table, set the status to APPROVED, file it LOCKED with its sidecar.
4. **Policy activation (G-3):** Finance Admin drafts a commercial policy version with `refund_execution_enabled: true`, `refund_policy_ref: "ARAMO-COM-REFUND-POL-001@1.0"`, `refund_policy_sha256: <sidecar>`; POLICY_ACTIVATE (Finance → Owner); approvers attest RX-3 in the reason and evidence (RX-4).
5. **Release (G-4), separate PO authorization:** encrypted `.env` snapshot; set `CCP_REFUND_EXECUTION_ENABLED=1`; recreate platform-admin and sign-service; reload nginx; verify (D6 checklist: ACTIVE policy hash = LOCKED sidecar).
6. **Live proof:** one real low-value purchase and a full refund through the console (Finance → Owner), confirmed in Stripe and reconciled in Aramo; recorded in a report.

## 4. Out of scope
App Store / Google Play refunds (the store refunds); Razorpay; automatic refund notifications to account holders; self-service refund requests; changes to the Personal Standard commitment (see §5).

## 5. Related finding — Personal Standard commitment (PO ruling 2026-11-15: month to month)
The published, counsel-approved Sign Terms of Service 2.0, §C (`doc/legal/aramo-sign/terms-of-service-2.0.md:517-521`), state that Personal Standard is "a 12-month commitment, billed monthly" and that cancellation takes effect at the end of the commitment. Selling it month to month therefore needs:
1. a Terms 2.1 change to §C (and the checkout disclosure), reviewed by counsel, with the change notice the published Terms require;
2. then a new Personal Standard catalog version with no commitment — after Apple approves iOS 1.0, so the App Store product is not touched during review (lesson of v3, 2026-11-15).
Until then v4 (12-month commitment) stays as published, consistent with the Terms buyers accept.

## 6. Rulings (PO 2026-11-15)
- **Q1 — APPROVED:** approve §3 step 1 (compose pass-through PR) now, ahead of the policy approval (recommended: it changes nothing while unset).
- **Q2 — APPROVED:** send refund policy revision 3 to counsel together with the Terms 2.1 commitment change (recommended: one counsel review).

## 7. Authority
This directive authorizes §3 steps 1–2 (compose pass-through PR, CI, merge, deploy with the variable unset). Steps 3–6 each need their own approval as stated: the refund policy must satisfy Charter A2 RX-3 (Finance, Legal counsel and Platform Owner approval, filed LOCKED with sidecar) before step 4; step 5 needs a separate PO release authorization.
