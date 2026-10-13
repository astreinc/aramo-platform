// @aramo/talent-intelligence — TIP-E2E INC-2 Talent Intelligence read-seam contracts.
// Thin scope:ats contract library: interfaces + DI tokens + neutral read shapes ONLY.
// Concrete cross-owner composition lives in apps/api adapters (no domain repos here).
export {
  REQUISITION_CONTEXT_READ_PORT,
  type RequisitionContextReadPort,
  type RequisitionContext,
  type RequisitionContextSummary,
  type RequisitionSkillRequirementContract,
  type RequirementType,
} from './lib/ports/requisition-context-read.port.js';

export {
  AUTHORIZED_TALENT_RETRIEVAL_READ_PORT,
  type AuthorizedTalentRetrievalReadPort,
  type AuthorizedTalentRecord,
} from './lib/ports/authorized-talent-retrieval-read.port.js';

export {
  TALENT_DOSSIER_READ_PORT,
  type TalentDossierReadPort,
  type DossierHead,
  type DossierVerificationOutcome,
} from './lib/ports/talent-dossier-read.port.js';
