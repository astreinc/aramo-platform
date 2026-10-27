-- Aramo-Sign-Unified-Product-Amendment-M-A5-Recipient-Kinds-Hosted-Self-Signing-v1_0-LOCKED
-- §1, §2, §3.5, §4.1 — recipient kinds, copy delivery, self-sign binding.
-- ADDITIVE ONLY: new columns with defaults and new CHECKs. Existing rows and every
-- existing creator keep recipient_kind SIGNER. Signer.email becomes nullable ONLY
-- for an IN_PERSON_SIGNER (CHECK). splitDdl-safe: no semicolons in comment lines.

-- §1.1 — the recipient kind, distinct from signer_role (the template role label).
ALTER TABLE "sign"."Signer" ADD COLUMN "recipient_kind" TEXT NOT NULL DEFAULT 'SIGNER';
ALTER TABLE "sign"."Signer"
  ADD CONSTRAINT "Signer_recipient_kind_check" CHECK ("recipient_kind" IN ('SIGNER', 'IN_PERSON_SIGNER', 'RECEIVES_COPY'));

-- §2.1 — copy_delivery is required if, and only if, the kind is RECEIVES_COPY.
ALTER TABLE "sign"."Signer" ADD COLUMN "copy_delivery" TEXT;
ALTER TABLE "sign"."Signer"
  ADD CONSTRAINT "Signer_copy_delivery_check" CHECK (
    ("recipient_kind" = 'RECEIVES_COPY' AND "copy_delivery" IS NOT NULL AND "copy_delivery" IN ('ON_SEND', 'ON_COMPLETION', 'BOTH'))
    OR ("recipient_kind" <> 'RECEIVES_COPY' AND "copy_delivery" IS NULL)
  );

-- §4.1 — Assign to me: the server sets the caller's user id (never client-supplied).
-- A copy recipient never signs, so it is never bound.
ALTER TABLE "sign"."Signer" ADD COLUMN "bound_user_id" UUID;
ALTER TABLE "sign"."Signer"
  ADD CONSTRAINT "Signer_bound_user_kind_check" CHECK ("bound_user_id" IS NULL OR "recipient_kind" <> 'RECEIVES_COPY');
CREATE INDEX "Signer_bound_user_id_idx" ON "sign"."Signer" ("bound_user_id") WHERE "bound_user_id" IS NOT NULL;

-- §3.5 — email is optional for an in-person signer only.
ALTER TABLE "sign"."Signer" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "sign"."Signer"
  ADD CONSTRAINT "Signer_email_required_check" CHECK ("email" IS NOT NULL OR "recipient_kind" = 'IN_PERSON_SIGNER');

-- §2.2 — a COPY_VIEW grant opens the source documents of a sent envelope (ON_SEND
-- copy). EXECUTED (the default) is the existing signed-copy grant.
ALTER TABLE "sign"."ExecutedAccessGrant" ADD COLUMN "access_kind" TEXT NOT NULL DEFAULT 'EXECUTED';
ALTER TABLE "sign"."ExecutedAccessGrant"
  ADD CONSTRAINT "ExecutedAccessGrant_access_kind_check" CHECK ("access_kind" IN ('EXECUTED', 'COPY_VIEW'));

-- §2.2 / §2.4 — the copy recipient's email is a recorded delivery (RECIPIENT_COPY).
ALTER TABLE "sign"."NotificationDelivery" DROP CONSTRAINT "NotificationDelivery_kind_check";
ALTER TABLE "sign"."NotificationDelivery"
  ADD CONSTRAINT "NotificationDelivery_kind_check"
  CHECK ("notification_kind" IN ('SIGNATURE_REQUEST', 'SIGNATURE_REMINDER', 'SIGNATURE_COMPLETED', 'SIGNATURE_DECLINED', 'SIGNATURE_EXPIRED', 'SIGNATURE_VOIDED', 'SIGNER_SIGNED', 'RECIPIENT_COPY'));
