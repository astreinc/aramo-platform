-- Aramo India Billing Regions + Razorpay Implementation Directive v1.0 (LOCKED) ruling Q7, §4.11 —
-- the owner's self-service cancel (end of period) of a Razorpay-billed subscription. Razorpay has no
-- hosted portal, so Aramo's own manage page records the cancel as a CCP-C7 SelfServiceBillingRequest
-- carried by a CCP-C1 command (whose provider CHECK already admits RAZORPAY, 20261113100000).
--
-- ADDITIVE: the request's provider CHECK admits 'RAZORPAY' beside 'STRIPE'. The action set stays
-- CANCEL_AT_PERIOD_END; the guard trigger (same provider and target as the subscription row, no open
-- governed row) is unchanged. Adjustments and usage stay Stripe-only (directive §7).
--
-- Compensating migration (documented, not shipped): RAISE while any RAZORPAY request exists; then
-- restore the CHECK to IN ('STRIPE').

ALTER TABLE "subscription"."SelfServiceBillingRequest" DROP CONSTRAINT "SelfServiceBillingRequest_provider_check";
ALTER TABLE "subscription"."SelfServiceBillingRequest"
    ADD CONSTRAINT "SelfServiceBillingRequest_provider_check" CHECK ("provider" IN ('STRIPE', 'RAZORPAY'));
