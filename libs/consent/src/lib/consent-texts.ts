import { createHash } from 'node:crypto';

import type { ConsentScopeValue } from './dto/consent-grant-request.dto.js';

// Portal P2 P2a (Directive §PR-1.3) — the versioned portal consent-text registry.
// The D7 `consent_text_hash` is sha256 of the EXACT rendered consent text the
// portal user saw; the preimage must be reproducible, so the text is a versioned
// template rendered deterministically from (version, recipient tenant, scope).
// The grant/revoke evidence stores {version, hash}; re-render the version with the
// event's tenant_id + scope to reproduce the preimage. P2b (portal-web) renders
// the SAME version so the portal user sees exactly what is hashed. No precedent
// existed — this establishes the closed registry (const-array idiom, like
// CONSENT_SCOPES). ADD-not-rename: a new version is a new key; an existing
// version's text is FROZEN (its hash is a permanent forensic anchor).
//
// The recipient is named by tenant_id (a stable recipient identifier available
// on both the write path and the ledger event). P2b MAY display a friendlier
// tenant name as chrome, but the canonical hashed legal text uses tenant_id.

export const CONSENT_TEXT_CURRENT_VERSION = 'portal-consent-v1';

export interface ConsentTextContext {
  recipient_tenant_id: string;
  scope: ConsentScopeValue;
}

// Human-readable clause per scope (frozen with the version).
// CI-B1: recording/transcription/ai_processing clauses satisfy the exhaustive
// Record type. The generic portal PROFILE consent template (portal-consent-v1)
// is NOT rendered for these conversation-operation scopes — they carry their own
// versioned disclosure via operation-notice-texts.ts (CI directive §4.4), and
// getPortalConsentTexts / the /consent/state matrix iterate PROFILE_CONSENT_SCOPES
// only. These clauses document scope meaning and remain available if ever surfaced.
const SCOPE_PHRASES: Record<ConsentScopeValue, string> = {
  profile_storage: 'store my profile',
  resume_processing: 'process my résumé',
  matching: 'match me to opportunities',
  contacting: 'contact me about opportunities',
  cross_tenant_visibility: 'share my profile beyond this organization',
  recording: 'record voice conversations with me',
  transcription: 'create written transcripts of conversations with me',
  ai_processing:
    'use automated (AI) analysis of conversation transcripts to assist recruiters',
};

// version id → deterministic renderer. Existing entries are FROZEN.
const TEMPLATES: Record<string, (ctx: ConsentTextContext) => string> = {
  'portal-consent-v1': (ctx) =>
    `I authorize the organization identified as ${ctx.recipient_tenant_id} to ` +
    `${SCOPE_PHRASES[ctx.scope]}. This authorization is effective for 12 months ` +
    `from the date I grant it, unless I revoke it earlier. I understand I may ` +
    `revoke this consent at any time from my Aramo portal.`,
};

export function renderPortalConsentText(
  version: string,
  ctx: ConsentTextContext,
): string {
  const tpl = TEMPLATES[version];
  if (tpl === undefined) {
    throw new Error(`unknown portal consent text version: ${version}`);
  }
  return tpl(ctx);
}

// The D7 evidence pair: {version, sha256hex(exact rendered text)}.
export function hashPortalConsentText(
  version: string,
  ctx: ConsentTextContext,
): { version: string; hash: string } {
  const text = renderPortalConsentText(version, ctx);
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  return { version, hash };
}

// ============================================================================
// Recruiter-capture attestation registry — PO RULING "Consent Capture" (provisional).
//
// Parallel to the portal (Talent-direct) registry above, but for the capture
// method where a RECRUITER records that the Talent authorized profile/recruiting
// consent on the Talent's behalf (captured_method='recruiter_capture'). The
// portal template is first-person Talent wording ("I authorize ...") and is NOT
// valid here, so this is a DISTINCT frozen version.
//
// PROVISIONAL / pending legal ratification: the version id carries the `-draft`
// suffix deliberately. It MUST NOT be silently renamed to a "final"/approved id.
// Later ratification either ratifies this version UNCHANGED or introduces a new
// recruiter-capture version PROSPECTIVELY (ADD-not-rename). Historical consent
// records are NEVER rewritten if the wording later changes — each event froze its
// {version, hash} at grant time.
//
// Per-scope decomposition is authorized by the ruling ("show the corresponding
// scope-specific clauses and record only the scopes affirmatively attested"): the
// renderer composes the shared attestation frame around ONE scope-specific clause,
// so each granted scope's event carries its own reproducible {version, hash}
// preimage. Only the three scopes named in the approved wording are covered; any
// other scope has no approved recruiter-capture text and renders a throw
// (fail-closed) rather than inventing wording.
export const CONSENT_TEXT_RECRUITER_CAPTURE_VERSION = 'recruiter-capture-v1-draft';

export type RecruiterCaptureScope = 'profile_storage' | 'matching' | 'contacting';
export const RECRUITER_CAPTURE_SCOPES: readonly RecruiterCaptureScope[] = [
  'profile_storage',
  'matching',
  'contacting',
] as const;

// The three scope-specific clauses, lifted verbatim from the ruling's wording.
const RECRUITER_CAPTURE_SCOPE_CLAUSES: Record<RecruiterCaptureScope, string> = {
  profile_storage:
    "store and maintain the Talent's profile and related recruiting information",
  matching:
    "use the Talent's profile to evaluate and match the Talent with employment opportunities",
  contacting: 'contact the Talent about recruiting opportunities',
};

export interface RecruiterCaptureTextContext {
  scope: RecruiterCaptureScope;
}

// version id → deterministic renderer. Existing entries are FROZEN.
const RECRUITER_CAPTURE_TEMPLATES: Record<
  string,
  (ctx: RecruiterCaptureTextContext) => string
> = {
  'recruiter-capture-v1-draft': (ctx) =>
    `I confirm that I obtained the Talent's authorization to ` +
    `${RECRUITER_CAPTURE_SCOPE_CLAUSES[ctx.scope]}. I confirm that this ` +
    `authorization was provided by the Talent and that I am recording it ` +
    `accurately on the Talent's behalf. I understand that the Talent may ` +
    `withdraw or change this authorization at any time, and that Aramo will ` +
    `apply the Talent's current consent status to future processing and ` +
    `communications.`,
};

export function renderRecruiterCaptureConsentText(
  version: string,
  ctx: RecruiterCaptureTextContext,
): string {
  const tpl = RECRUITER_CAPTURE_TEMPLATES[version];
  if (tpl === undefined) {
    throw new Error(`unknown recruiter-capture consent text version: ${version}`);
  }
  return tpl(ctx);
}

// The D7 evidence pair for recruiter-capture: {version, sha256hex(exact text)}.
export function hashRecruiterCaptureConsentText(
  version: string,
  ctx: RecruiterCaptureTextContext,
): { version: string; hash: string } {
  const text = renderRecruiterCaptureConsentText(version, ctx);
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  return { version, hash };
}
