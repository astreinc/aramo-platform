import { createHash } from 'node:crypto';

import { type Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { type DocumentStoragePort, type TemplatesRepository, type TemplateTenantLogoPort } from '@aramo/documents';
import { type LetterheadModel } from '@aramo/documents-rendering';

import { type RtrHtmlLogoRef } from './rtr-html-content.js';

// The letterhead an RTR-content template version renders with. Shared by the ATS RTR
// orchestrator and (DOC-TEMPLATE-LIB-1 T-5) the Aramo Sign template render, so an Aramo
// default carries the SAME tenant branding whichever product generates the document.

export interface LetterheadDeps {
  readonly templates: TemplatesRepository;
  readonly storage: DocumentStoragePort;
  readonly tenantLogo?: TemplateTenantLogoPort;
  readonly logger: Logger;
}

// DOC-TEMPLATE-LIB-1 T-3 (§4.3) — brand an Aramo default with the tenant's logo, captured
// through the existing tenant-logo seam (https only, no redirects, 5 s, 1 MB, PNG/JPEG
// magic-checked) into a per-render tenant TemplateAsset, then read back + sha-verified
// exactly like a tenant template's frozen logo. No profile logo ⇒ no letterhead. A logo
// that cannot be captured (bad URL, fetch failure, wrong type) degrades to no letterhead
// rather than blocking the document: branding is presentation, the legal content is the
// Aramo default's own, and the frozen revision records exactly what was rendered.
export async function captureTenantLetterhead(
  deps: LetterheadDeps,
  tenant_id: string,
  actor_id: string,
  requestId: string,
): Promise<LetterheadModel | undefined> {
  if (deps.tenantLogo === undefined) return undefined;
  const info = await deps.tenantLogo.info(tenant_id);
  if (!info.available) return undefined;
  let captured;
  try {
    captured = await deps.tenantLogo.capture({ tenant_id, requestId });
  } catch (e) {
    if (!(e instanceof AramoError)) throw e;
    const reason = (e.context.details as { reason?: unknown } | undefined)?.reason;
    deps.logger.warn(`tenant logo not captured for an Aramo default (request ${requestId}): ${String(reason ?? e.code)}`);
    return undefined;
  }
  const asset = await deps.templates.createAsset({
    tenant_id,
    asset_kind: 'LOGO',
    sha256: captured.sha256,
    mime_type: captured.mime,
    storage_provider: captured.storage_provider,
    storage_locator: captured.storage_locator,
    name: 'tenant.logo',
    created_by: actor_id,
  });
  return loadLetterhead(deps, tenant_id, { asset_id: asset.id, sha256: captured.sha256, mime: captured.mime }, requestId);
}

// A1 §2.4 — a TENANT version's FROZEN logo: bytes read from the TemplateAsset's storage
// and sha-verified against both the asset row and the content's reference.
export async function loadLetterhead(
  deps: Pick<LetterheadDeps, 'templates' | 'storage'>,
  tenant_id: string,
  logo: RtrHtmlLogoRef,
  requestId: string,
): Promise<LetterheadModel> {
  const invalid = (reason: string): AramoError =>
    new AramoError('RTR_TEMPLATE_CONFIGURATION_INVALID', 'The active Right to Represent template logo is not usable', 422, {
      requestId,
      details: { reason },
    });
  const asset = await deps.templates.findAssetById(tenant_id, logo.asset_id);
  if (asset === null) throw invalid('logo_asset_missing');
  const bytes = await deps.storage.getArtifact({ storage_key: asset.storage_locator, requestId, maxBytes: 1024 * 1024 });
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== asset.sha256 || sha !== logo.sha256) throw invalid('logo_asset_hash_mismatch');
  return { image_bytes: new Uint8Array(bytes), image_format: logo.mime === 'image/png' ? 'PNG' : 'JPG', image_sha256: sha, name: null };
}
