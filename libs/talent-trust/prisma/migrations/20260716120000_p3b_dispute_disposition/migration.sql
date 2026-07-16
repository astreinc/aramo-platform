-- Portal P3b (Amendment v1.2 Pin B) — the tenant disposition durable-skip reason.
-- A work item whose backing evidence is not disputable at disposition time
-- (SUPERSEDED/CONTRADICTED/STALE) lands as status RESOLVED_NO_TRANSITION with this
-- reason. Additive nullable column TEXT (the status vocab is TEXT + @IsIn, no DB
-- CHECK per the talent_trust convention — a new value is additive at the DTO layer).
ALTER TABLE "talent_trust"."PortalDisputeWorkItem" ADD COLUMN "no_transition_reason" TEXT;
