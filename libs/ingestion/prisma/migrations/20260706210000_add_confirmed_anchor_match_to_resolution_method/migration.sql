-- TR-2a-B2 (DDR-2 §6) — add confirmed_anchor_match to the ResolutionMethod enum
-- The new writable value for a deterministic Tier-A both-sides-confirming
-- resolve. verified_email_match + caller_supplied remain as read-widened
-- historical values (never newly written). sha256_payload_dup is NOT added
-- (item-3: no dedup short-circuit records a method). Positioned BEFORE
-- verified_email_match to match the schema declaration order.
ALTER TYPE "ingestion"."ResolutionMethod" ADD VALUE IF NOT EXISTS 'confirmed_anchor_match' BEFORE 'verified_email_match';
