// @aramo/sign-client — the Sign rules that must run on the device
// (Aramo-Sign-Client-Rule-Consolidation-Directive-v1_0-LOCKED §1 G-3, §4 C2).
//
// Pure TypeScript ESM: no React, no React Native, no DOM, no `node:*`, no Buffer, no
// Prisma, no Nest, and no npm dependency (nx module boundary: type:client-shared). One
// copy, imported by apps/sign-web, mobile/sign and libs/sign (the server).
//
// Relative imports carry the `.js` suffix (the repo's nodenext rule). Metro resolves them
// to the `.ts` source through mobile/sign/metro.config.js; Jest through moduleNameMapper.

export {
  SIGN_DATE_FORMATS,
  DEFAULT_SIGN_DATE_FORMAT,
  SIGN_DATE_FALLBACK_TIME_ZONE,
  formatSignDate,
  resolveSignerTimeZone,
  localTimeZone,
  signDatePreview,
  type SignDateFormat,
} from './lib/sign-date.js';
export {
  SIGNER_NAME_MODES,
  CHECKBOX_GROUP_RULES,
  CHECK_FIELD_TYPES,
  PAYMENT_FIELD_TYPE,
  PROFILE_TEXT_FIELD_TYPES,
  PROFILE_TEXT_MAX,
  isProfileTextField,
  profileTextValueRefusal,
  isPaymentField,
  isServerFilledName,
  evaluateSignerFieldRules,
  type SignerNameMode,
  type CheckboxGroupRule,
  type FieldRuleRow,
  type ProfileTextFieldType,
  type FieldRuleViolation,
} from './lib/field-rules.js';
export {
  RECIPIENT_KINDS,
  SIGNING_RECIPIENT_KINDS,
  COPY_DELIVERIES,
  MAX_COPY_RECIPIENTS,
  type RecipientKind,
  type CopyDelivery,
} from './lib/recipients.js';
export {
  ENVELOPE_TRANSITIONS,
  TERMINAL_ENVELOPE_STATUSES,
  SIGNABLE_ENVELOPE_STATUSES,
  isTerminalEnvelopeStatus,
  predecessorsOf,
} from './lib/envelope-lifecycle.js';
export {
  EnvelopeRevisionMismatchError,
  ReminderLimitError,
  InboxSigningRefusedError,
  IdempotencyKeyReuseError,
  IdempotencyRequestInProgressError,
  SessionIssueRefusedError,
  AttestedNameRequiredError,
  type ReminderLimitReason,
  type InboxSigningRefusal,
  type SessionIssueRefusal,
} from './lib/envelope-contract-errors.js';
