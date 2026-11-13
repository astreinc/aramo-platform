-- Aramo India Billing Regions + Razorpay Implementation Directive v1.0 (LOCKED) §2 (supersedes Signup
-- A1 "Organization Details US Only"), §4.9 — a Business organization may be held to the India region
-- once that region's Business switch is ON (the gate is in code: the billing region store decides; with
-- India OFF nothing writes 'IN'). ADDITIVE: the region CHECK admits 'IN' beside 'US'. Existing rows
-- (all 'US') are unchanged; no returned shape changes.
--
-- Compensating migration (documented, not shipped): RAISE while any 'IN' row exists; then restore the
-- CHECK to IN ('US').

ALTER TABLE "identity"."TenantBillingRegionPolicy" DROP CONSTRAINT "TenantBillingRegionPolicy_region_check";
ALTER TABLE "identity"."TenantBillingRegionPolicy"
    ADD CONSTRAINT "TenantBillingRegionPolicy_region_check" CHECK ("region" IN ('US', 'IN'));
