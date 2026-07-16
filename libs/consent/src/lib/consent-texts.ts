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
const SCOPE_PHRASES: Record<ConsentScopeValue, string> = {
  profile_storage: 'store my profile',
  resume_processing: 'process my résumé',
  matching: 'match me to opportunities',
  contacting: 'contact me about opportunities',
  cross_tenant_visibility: 'share my profile beyond this organization',
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
