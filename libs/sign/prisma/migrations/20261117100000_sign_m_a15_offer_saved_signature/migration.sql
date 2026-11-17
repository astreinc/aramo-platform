-- Aramo-Sign-Mobile-Amendment-M-A15-Guest-Saved-Signature-v1_0 §5 — the user's choice
-- to offer their saved signature on emailed signing links. Additive, defaulted: every
-- existing row reads true; no existing client is affected.
ALTER TABLE "sign"."SignUserSettings"
  ADD COLUMN "offer_saved_signature_on_links" BOOLEAN NOT NULL DEFAULT true;
