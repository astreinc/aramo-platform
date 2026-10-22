# Backlog: Aramo Sign Personal — choose and connect an SMS provider

**Status:** OPEN. SMS is on hold by PO decision (2026-10-21).

**Raised by:**
- `Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED` §6.3;
- `Aramo-Sign-Personal-Free-Launch-Directive-v1_1-Amendment-A1-v1_0-LOCKED` §A1-2 and §A1-6.

## What

Some Personal signups and sends land in the "step-up" band of the risk rating. Step-up was designed to ask for a one-time SMS code to the person's phone.

The code side is built:
- `SmsVerificationPort` with the `send(e164, text)` interface (`libs/identity/src/lib/personal/sms-verification.port.ts`);
- Aramo generates and hashes the 6-digit codes: valid 10 minutes, 5 tries;
- adapters: `log` (dev/test) and `disabled`, which is the production default via `SIGN_SMS_PROVIDER` unset.

**No real provider is connected.**

## What happens today (A1-2)

**Step-up routed to review.** While SMS is unavailable, a step-up signup goes to the operator review queue, with reason `step_up_phone_unavailable`.

**Clearing the review.** An operator clearing the review lifts the phone step (`step_up_cleared_by = 'review'`). It never marks the phone verified: `phone_verified_at` stays NULL (Lead correction C).

**The cost.** Every step-up account needs a person to review it, so operator workload grows with signups. That cost matters before `open` (public) signup.

## What selecting a provider involves

1. **Choose a provider** covering the United States and India.

   Options to evaluate: AWS SNS / AWS End User Messaging (already our cloud vendor), Twilio Verify/Messaging, MessageBird/Bird, MSG91 (India).

   Compare:
   - delivery to US and IN numbers;
   - per-message cost;
   - support for sender IDs and templates.
2. **India: DLT registration.** TRAI rules require registering the business entity and the message template on a DLT platform, through the provider or an Indian operator, before SMS can be delivered to Indian numbers. Plan lead time for this.
3. **US: compliance.** Follow TCPA: verification only, never marketing. 10DLC or toll-free sender registration may be required, depending on the provider.
4. **Contracts.** Accept the provider terms in Astre's name. Add the provider to the subprocessor list at `sign.aramo.ai/legal/subprocessors`. Update the Privacy Notice's "SMS provider — not yet selected" with the provider's name: that is a new document version and needs re-acceptance.
5. **Code.**
   - Write one adapter implementing `SmsVerificationPort`.
   - Put its secrets in the box `.env`, never in Git.
   - Set `SIGN_SMS_PROVIDER=<name>`.
   - Add a delivery-failure and rate-limit test.
   - Existing behaviour switches automatically: when the port reports `configured`, step-up asks for a phone code again and review no longer lifts the phone step.
6. **Cost controls.**
   - Per-number and per-IP send limits; existing: 60 seconds between sends, 5 a day.
   - A monthly spend alert at the provider.

## Acceptance

- Provider contract and registrations done (DLT for India).
- The adapter merged with tests.
- The subprocessor list and Privacy Notice updated, with a new version and re-acceptance.
- PO authorization to enable it in production.
