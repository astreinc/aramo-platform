-- Pipeline & RTR Recon Remediation Directive v1.0 LOCKED §2 R2 (DEF-12; PO 2026-10-21: a new
-- DECLINED status) — a document whose signer declined is DECLINED, distinct from VOIDED (sender
-- withdrew) and EXPIRED (signing window passed). Additive: the CHECK gains one value; every
-- existing row already satisfies it.
ALTER TABLE "documents"."Document" DROP CONSTRAINT "Document_status_check";
ALTER TABLE "documents"."Document"
  ADD CONSTRAINT "Document_status_check"
  CHECK ("status" IN ('DRAFT', 'PREPARED', 'EXECUTION_PENDING', 'EXECUTED', 'VOIDED', 'EXPIRED', 'DECLINED', 'ARCHIVED'));
