// Public surface of @aramo/job-distribution (SRC-2). ATS-side requisition-outbound
// distribution substrate. Ships INERT at PR-2: the schema + the allowlist payload
// builder only — the sweep, connector, and OAuth token service are PR-3/PR-4.
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
