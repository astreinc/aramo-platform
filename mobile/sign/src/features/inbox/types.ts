// Response shapes the Agreements / detail / inbox screens read: aliases of the GENERATED
// OpenAPI types (src/api/generated/sign.ts). Only what openapi/sign.yaml still lacks is
// added here. Nothing here is policy: the screens render what the server decided.
import type { components } from '../../api/generated/sign';

type Schemas = components['schemas'];

export const ENVELOPE_STATUSES = [
  'DRAFT',
  'SENT',
  'IN_PROGRESS',
  'COMPLETED',
  'DECLINED',
  'VOIDED',
  'EXPIRED',
] as const satisfies readonly Schemas['SenderEnvelopeStatus'][];
export type EnvelopeStatus = Schemas['SenderEnvelopeStatus'];

export const END_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETED',
  'DECLINED',
  'VOIDED',
  'EXPIRED',
]);
export const OPEN_STATUSES: ReadonlySet<string> = new Set(['SENT', 'IN_PROGRESS']);

export type RecipientStatus = Schemas['SenderRecipientStatus'];

/** One row of GET /v1/sign/sender/envelopes `items`. */
export type SenderListItem = Schemas['SenderEnvelopeListItem'];
export type SenderListRecipient = SenderListItem['recipients'][number];
export type SenderEnvelopeList = Schemas['SenderEnvelopeList'];

/** One item of GET /v1/sign/inbox (recipient facts only, §4.6). */
export type InboxItem = Schemas['RecipientInboxItem'];
export type InboxList = Schemas['RecipientInbox'];

export type DetailDocument = Schemas['SenderEnvelopeDocument'];
export type DetailRecipient = Schemas['SenderEnvelopeRecipient'];

/** GET /v1/sign/sender/envelopes/{id} (ETag "{id}.{revision}"). */
export type SenderEnvelopeDetail = Schemas['SenderEnvelopeDetail'];

export type SenderExecutedDocuments = Schemas['SenderExecutedDocuments'];

/**
 * The YAML's SenderLedgerEvent still lacks `actor_type` and `detail`, which events()
 * returns (apps/sign-service/src/app/sender/sender-envelope.service.ts); kept optional.
 */
export type LedgerEvent = Schemas['SenderLedgerEvent'] & {
  readonly actor_type?: string;
  readonly detail?: Readonly<Record<string, unknown>> | string | null;
};

export type SenderContext = Schemas['SenderContext'];

export type BillingAccount = Schemas['BillingAccount'];

/** The application id sign-service stamps on envelopes created in Aramo Sign. */
export const SIGN_APPLICATION = 'aramo-sign';
