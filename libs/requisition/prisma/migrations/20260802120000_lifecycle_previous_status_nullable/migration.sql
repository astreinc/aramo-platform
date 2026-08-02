-- Track 1 T1-c — wire RequisitionLifecycleEvent. R1: a CREATE emits an event
-- whose previous_status is NULL — the first status a requisition ever has is
-- part of its history, and it has no predecessor. PR-0c (§D17c) shipped
-- previous_status NOT NULL, which makes R1 unsatisfiable. This widens ONLY the
-- origin column to nullable. next_status stays NOT NULL — every event has a
-- destination; only the origin can be absent, and only on a create. This does
-- NOT touch the table's append-only property (no update/delete path added).

-- AlterColumn
ALTER TABLE "requisition"."RequisitionLifecycleEvent"
  ALTER COLUMN "previous_status" DROP NOT NULL;
