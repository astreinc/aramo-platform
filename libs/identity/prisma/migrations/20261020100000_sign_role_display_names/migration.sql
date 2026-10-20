-- Sign role display names. Organization admin showed the four Sign roles as
-- "E-Sign Owner/Admin/Sender/Viewer" while the Sign app calls them "Sign …".
-- The role catalog derives the display name from the description's leading
-- phrase. The seed's upsertRole never updates an existing row (update: {}), so
-- existing databases are corrected here. Description text only: role keys,
-- ids, scopes and grants are unchanged. Idempotent.
-- splitDdl-safe: no semicolons inside comment lines.
UPDATE "identity"."Role" SET "description" = 'Sign Owner — top authority of a Sign organization; full envelope authority (create/send/read).', "updated_at" = now() WHERE "key" = 'esign_owner' AND "description" IS DISTINCT FROM 'Sign Owner — top authority of a Sign organization; full envelope authority (create/send/read).';
UPDATE "identity"."Role" SET "description" = 'Sign Admin — administrative operator of a Sign organization; full envelope authority (create/send/read).', "updated_at" = now() WHERE "key" = 'esign_admin' AND "description" IS DISTINCT FROM 'Sign Admin — administrative operator of a Sign organization; full envelope authority (create/send/read).';
UPDATE "identity"."Role" SET "description" = 'Sign Sender — creates and dispatches envelopes for signature (create/send/read). No org administration.', "updated_at" = now() WHERE "key" = 'esign_sender' AND "description" IS DISTINCT FROM 'Sign Sender — creates and dispatches envelopes for signature (create/send/read). No org administration.';
UPDATE "identity"."Role" SET "description" = 'Sign Viewer — read-only access to envelopes + signing history (read).', "updated_at" = now() WHERE "key" = 'esign_viewer' AND "description" IS DISTINCT FROM 'Sign Viewer — read-only access to envelopes + signing history (read).';
