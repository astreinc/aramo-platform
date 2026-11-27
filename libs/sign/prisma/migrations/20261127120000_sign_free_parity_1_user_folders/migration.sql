-- SIGN-FREE-PARITY-1 S7 (FP-R8) — a user's own folders for envelopes. Per user (the folder
-- owner is the Aramo user, within their tenant). The system Deleted folder
-- (SignEnvelopePartyDeletion) is unchanged.
-- Additive: two new tables only.
--
--   SignUserFolder      a named folder (name ≤ 60 characters, unique per owner without case).
--   SignUserFolderItem  what is in it: item_kind SENDER (item_ref = an envelope id the owner
--                       can see) or RECIPIENT (item_ref = the owner's own signer id, as in
--                       RecipientInboxRemoval). No FK to the envelope (SignUserFavorite
--                       precedent): a marker only. Deleting a folder removes its items, never
--                       an envelope. An item is in at most one folder per owner (enforced
--                       by the service: moving replaces).

CREATE TABLE "sign"."SignUserFolder" (
  "id"            UUID        NOT NULL,
  "tenant_id"     UUID        NOT NULL,
  "owner_user_id" UUID        NOT NULL,
  "name"          TEXT        NOT NULL,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SignUserFolder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignUserFolder_name_check" CHECK (char_length("name") BETWEEN 1 AND 60)
);
CREATE UNIQUE INDEX "SignUserFolder_owner_name_key" ON "sign"."SignUserFolder" ("tenant_id", "owner_user_id", lower("name"));
CREATE INDEX "SignUserFolder_owner_idx" ON "sign"."SignUserFolder" ("tenant_id", "owner_user_id");

CREATE TABLE "sign"."SignUserFolderItem" (
  "folder_id" UUID        NOT NULL,
  "item_kind" TEXT        NOT NULL,
  "item_ref"  UUID        NOT NULL,
  "added_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SignUserFolderItem_pkey" PRIMARY KEY ("folder_id", "item_kind", "item_ref"),
  CONSTRAINT "SignUserFolderItem_item_kind_check" CHECK ("item_kind" IN ('SENDER', 'RECIPIENT')),
  CONSTRAINT "SignUserFolderItem_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "sign"."SignUserFolder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SignUserFolderItem_item_idx" ON "sign"."SignUserFolderItem" ("item_kind", "item_ref");
