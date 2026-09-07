import { createHash } from 'node:crypto';

// CI-B1 (Aramo-CI-Conversation-Intelligence-Directive-v1_2-LOCKED §4.4) — the
// versioned DISCLOSURE / NOTICE registry for the conversation-operation consent
// scopes (recording, transcription, ai_processing).
//
// This is distinct from:
//   - consent-texts.ts   (the portal PROFILE consent template, portal-consent-v1); and
//   - notice-texts.ts    (the platform IDENTITY / RTBF notice, portal-notice-v1).
//
// Purpose: give each conversation operation its OWN reproducible, hashable
// disclosure text so a consent decision can capture, per §4.4, a {notice version,
// content hash / exact snapshot} pair as evidence — using the same sha256-of-exact-
// rendered-text discipline as consent-texts.ts. The grant/decision evidence stores
// {version, hash}; re-render the version with the event's recipient tenant to
// reproduce the preimage.
//
// ADD-not-rename: a new version is a NEW key; an existing version's text is FROZEN
// (its sha256 is a permanent forensic anchor).
//
// COUNSEL-GOVERNED, NOT LAW-IN-CODE: this copy is placeholder policy disclosure
// text. It does NOT encode jurisdiction-specific law. Which operations require
// affirmative consent vs. notice vs. are tenant-permitted vs. prohibited — and the
// operative legal meaning by jurisdiction — is resolved by tenant policy / counsel,
// never inferred here. Provider capability is never proof of consent.

// The three conversation operations that carry an independent disclosure notice.
// Mirrors the CI directive §4.1 operation set (excludes `contacting`, which keeps
// its existing profile/consent machinery).
export const CONVERSATION_NOTICE_OPERATIONS = [
  'recording',
  'transcription',
  'ai_processing',
] as const;
export type ConversationNoticeOperation =
  (typeof CONVERSATION_NOTICE_OPERATIONS)[number];

// Current disclosure version per operation. ADD-not-rename: bump to -v2 (new key
// in TEMPLATES) when the disclosure text must change; never edit a frozen version.
export const OPERATION_NOTICE_CURRENT_VERSION: Record<
  ConversationNoticeOperation,
  string
> = {
  recording: 'recording-notice-v1',
  transcription: 'transcription-notice-v1',
  ai_processing: 'ai-processing-notice-v1',
};

export interface OperationNoticeContext {
  // The recipient organization named in the disclosure (stable identifier
  // available on both the write path and the ledger event), mirroring the
  // consent-texts.ts recipient_tenant_id convention.
  recipient_tenant_id: string;
}

// version id → deterministic renderer. Existing entries are FROZEN.
const TEMPLATES: Record<string, (ctx: OperationNoticeContext) => string> = {
  'recording-notice-v1': (ctx) =>
    `The organization identified as ${ctx.recipient_tenant_id} may record voice ` +
    `conversations with me. I understand this authorization is independent of any ` +
    `other permission, is effective until I revoke it, and that I may revoke it at ` +
    `any time.`,
  'transcription-notice-v1': (ctx) =>
    `The organization identified as ${ctx.recipient_tenant_id} may create written ` +
    `transcripts of conversations with me. I understand a transcript may be ` +
    `produced whether or not the conversation is recorded, that this authorization ` +
    `is independent of any other permission, and that I may revoke it at any time.`,
  'ai-processing-notice-v1': (ctx) =>
    `The organization identified as ${ctx.recipient_tenant_id} may use automated ` +
    `(AI) analysis of conversation transcripts to assist its recruiters. I ` +
    `understand any AI-generated output is a draft reviewed by a human, that this ` +
    `authorization is independent of any other permission, and that I may revoke ` +
    `it at any time.`,
};

export function renderOperationNotice(
  version: string,
  ctx: OperationNoticeContext,
): string {
  const tpl = TEMPLATES[version];
  if (tpl === undefined) {
    throw new Error(`unknown operation notice version: ${version}`);
  }
  return tpl(ctx);
}

// The §4.4 evidence pair: {version, sha256hex(exact rendered text)}.
export function hashOperationNotice(
  version: string,
  ctx: OperationNoticeContext,
): { version: string; hash: string } {
  const text = renderOperationNotice(version, ctx);
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  return { version, hash };
}
