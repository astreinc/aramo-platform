-- COMM-C4 (RCE-1) — capture the final sent email subject and body as durable
-- evidence on the CommunicationInteraction system of record. Both are NULLABLE:
-- voice and meeting channels carry no subject/body, and pre-existing rows have
-- none. ADD-not-rename (no column is repurposed). No trigger references these
-- columns, so the NULLABLE-column immutability hazard does not apply.
ALTER TABLE communications."CommunicationInteraction"
  ADD COLUMN "subject" TEXT,
  ADD COLUMN "body" TEXT;
