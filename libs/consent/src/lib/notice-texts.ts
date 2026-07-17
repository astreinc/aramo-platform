import { createHash } from 'node:crypto';

// Portal P4 P4a (Aramo-Portal-P4-Directive-v1_0-LOCKED §PR-1.1, D-5) — the
// versioned PLATFORM NOTICE registry. The P2a `consent-texts.ts` pattern verbatim
// (const-array idiom, frozen deterministic renderer, ADD-not-rename): a version
// id + a frozen renderer whose bytes are BOTH what the portal serves at
// `GET /v1/portal/notice` AND what the dormant-notice email delivers — the same
// bytes, so a delivery record's `notice_version` reproduces the exact preimage.
//
// This is the platform's OWN notice (the processor/controller-model disclosure a
// person receives about how Aramo, as a platform, holds a cross-organization
// identity record and the rights they may exercise against it). It carries NO
// tenant attribution and no ranking/tier vocabulary — a general, always-available
// disclosure. An existing version's text is FROZEN (its hash is a permanent
// forensic anchor); a new version is a new key.
//
// notice_version threads into the P2a consent-evidence forward contract: at a
// portal grant/revoke, the version in force (`NOTICE_TEXT_CURRENT_VERSION`) is
// stamped into `consent_evidence.notice_version` (the P2a nullable → populated).

export const NOTICE_TEXT_CURRENT_VERSION = 'portal-notice-v1';

// version id → deterministic renderer (no context — the platform notice is
// general, not per-tenant/per-scope). Existing entries are FROZEN.
const NOTICE_TEMPLATES: Record<string, () => string> = {
  'portal-notice-v1': () =>
    'Aramo maintains a record of your professional identity that may span more ' +
    'than one organization using Aramo. We keep this record so that the ' +
    'organizations you engage with can recognize you and so that you can see and ' +
    'control what is held about you.\n\n' +
    'You have rights over the identity Aramo holds as a platform. You can view ' +
    'what has been verified about you, dispute anything that is wrong, and ask ' +
    'Aramo to permanently delete your platform identity and sign-in at any time ' +
    'from your Aramo portal.\n\n' +
    'Each organization that holds its own record of you is a separate controller ' +
    'of that record. Deleting your Aramo platform identity does not delete the ' +
    'records those organizations hold; you exercise your rights against each of ' +
    'them separately.',
};

export function renderPlatformNotice(version: string): string {
  const tpl = NOTICE_TEMPLATES[version];
  if (tpl === undefined) {
    throw new Error(`unknown platform notice version: ${version}`);
  }
  return tpl();
}

// The forensic pair: {version, sha256hex(exact rendered notice bytes)} — the same
// preimage the portal serves and the email delivers.
export function hashPlatformNotice(version: string): {
  version: string;
  hash: string;
} {
  const text = renderPlatformNotice(version);
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  return { version, hash };
}

// The email envelope — the notice BODY bytes are identical to the portal-served
// text (D-5 "email renders the same bytes"); only a subject + minimal HTML wrapper
// are added for the mail channel.
export function renderPlatformNoticeEmail(version: string): {
  subject: string;
  html: string;
  text: string;
} {
  const body = renderPlatformNotice(version);
  const html = body
    .split('\n\n')
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br/>')}</p>`)
    .join('\n');
  return {
    subject: 'An important notice about your information on Aramo',
    text: body,
    html,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
