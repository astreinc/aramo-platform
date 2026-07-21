// Public surface of @aramo/job-distribution (SRC-2). ATS-side requisition-outbound
// distribution substrate. This lib is buildable-import-free (zero @aramo edges);
// the sweep orchestration + BullMQ processor live in apps/api (PRIMARY ruling).
export {
  buildChannelPostingPayload,
  channelPostingContentHash,
} from './lib/channel-posting-payload.builder.js';
export {
  SYNC_STATUSES,
  type SyncStatus,
  type ChannelPostingInput,
  type ChannelPostingPayload,
} from './lib/channel-posting.types.js';

// PR-3 — the connector + token service + posting-state repo + pure planners.
export { JobDistributionModule } from './lib/job-distribution.module.js';
export { PrismaService as JobDistributionPrismaService } from './lib/prisma/prisma.service.js';
export {
  JobDistributionPostingStateRepository,
  type ChannelPostingStateRow,
  type TenantChannelConfigRow,
} from './lib/job-distribution-posting-state.repository.js';
export { IndeedTokenService } from './lib/indeed/indeed-token.service.js';
export {
  IndeedJobSyncConnector,
  IndeedConnectorError,
  type IndeedJobContext,
  type IndeedEmployerId,
  type IndeedApplyConfig,
  type IndeedCreateResult,
} from './lib/indeed/indeed-job-sync.connector.js';
export {
  planPublishableAction,
  shouldExpire,
  type PostingAction,
  type ExistingPostingState,
} from './lib/posting-transition.js';
export {
  decimalStringToMinorUnits,
  InvalidMinorUnitsError,
} from './lib/minor-units.js';
export {
  INDEED_CHANNEL,
  INDEED_APPLY_WEBHOOK_PATH,
  INDEED_CLIENT_ID_ENV,
  INDEED_CLIENT_SECRET_ENV,
  INDEED_OAUTH_SCOPE_ENV,
  INDEED_GRAPHQL_BASE_ENV,
} from './lib/indeed/indeed.constants.js';
