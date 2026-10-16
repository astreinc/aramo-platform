import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import { AramoError } from '@aramo/common';
import type { CapturedTenantLogo, DocumentStoragePort, TemplateTenantLogoPort, TenantLogoInfo } from '@aramo/documents';
import { type TenantRepository } from '@aramo/identity';

// DOC-TEMPLATE-ADMIN-RTR-1 Amendment A1 §2.4 — the tenant-profile logo seam.
//
// The logo is bound to the logo stored in Tenant profile (Tenant.logo_url, PO ruling
// 2026-10-16). Because the renderer may NOT fetch the network, the logo is fetched ONCE,
// here, at the admin "add logo" action, and frozen as a TemplateAsset (bytes in the
// documents object storage + sha256 on the asset row). Later Tenant-profile changes never
// touch ACTIVE/RETIRED versions; a new draft picks up a new logo only when re-captured.
//
// Fetch guardrails: https only; IP-literal / localhost / private-range hosts refused;
// no redirects; 5 s timeout; 1 MB cap (header AND streamed); declared content-type must
// be image/png or image/jpeg AND match the magic bytes.

export const LOGO_MAX_BYTES = 1024 * 1024;
export const LOGO_FETCH_TIMEOUT_MS = 5000;

type Fetcher = (url: string, init: { signal: AbortSignal; redirect: 'error'; headers: Record<string, string> }) => Promise<Response>;

function logoError(status: number, reason: string, requestId: string, message: string): AramoError {
  return new AramoError('VALIDATION_ERROR', message, status, { requestId, details: { reason } });
}

function isBlockedHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  // Refuse IP literals outright (a tenant logo is served from a named host).
  return isIP(h) !== 0;
}

export function sniffImageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

export class RtrTemplateTenantLogoService implements TemplateTenantLogoPort {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly storage: DocumentStoragePort,
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
  ) {}

  async info(tenant_id: string): Promise<TenantLogoInfo> {
    const b = await this.tenants.findBrandingById(tenant_id);
    const name = (b?.display_name ?? '').trim() || (b?.legal_name ?? '').trim() || (b?.name ?? '').trim();
    return { available: (b?.logo_url ?? '').trim().length > 0, tenant_name: name.length > 0 ? name : null };
  }

  async capture(input: { tenant_id: string; requestId: string }): Promise<CapturedTenantLogo> {
    const { requestId } = input;
    const b = await this.tenants.findBrandingById(input.tenant_id);
    const raw = (b?.logo_url ?? '').trim();
    if (raw.length === 0) throw logoError(409, 'no_tenant_logo', requestId, 'The Tenant profile has no logo to add');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw logoError(422, 'logo_url_invalid', requestId, 'The Tenant profile logo URL is not a valid URL');
    }
    if (url.protocol !== 'https:') throw logoError(422, 'logo_url_not_https', requestId, 'The Tenant profile logo must be an https URL');
    if (url.username !== '' || url.password !== '' || isBlockedHost(url.hostname)) {
      throw logoError(422, 'logo_url_host_refused', requestId, 'The Tenant profile logo host is not allowed');
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LOGO_FETCH_TIMEOUT_MS);
    let bytes: Buffer;
    let declared: string;
    try {
      let res: Response;
      try {
        res = await this.fetcher(url.toString(), { signal: ctrl.signal, redirect: 'error', headers: { accept: 'image/png, image/jpeg' } });
      } catch {
        throw logoError(422, 'logo_fetch_failed', requestId, 'The Tenant profile logo could not be fetched');
      }
      if (!res.ok) throw logoError(422, 'logo_fetch_failed', requestId, `The Tenant profile logo could not be fetched (HTTP ${res.status})`);
      declared = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      const len = Number(res.headers.get('content-length') ?? 'NaN');
      if (Number.isFinite(len) && len > LOGO_MAX_BYTES) throw logoError(422, 'logo_too_large', requestId, 'The Tenant profile logo exceeds 1 MB');
      bytes = await this.readCapped(res, requestId);
    } finally {
      clearTimeout(timer);
    }
    if (declared !== 'image/png' && declared !== 'image/jpeg') {
      throw logoError(422, 'logo_type_invalid', requestId, 'The Tenant profile logo must be a PNG or JPEG image');
    }
    const sniffed = sniffImageMime(bytes);
    if (sniffed === null || sniffed !== declared) {
      throw logoError(422, 'logo_type_invalid', requestId, 'The Tenant profile logo bytes are not a PNG or JPEG image');
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const ext = sniffed === 'image/png' ? 'png' : 'jpg';
    const storage_locator = `documents/${input.tenant_id}/template-assets/logo/${sha256}.${ext}`;
    await this.storage.putArtifact({ storage_key: storage_locator, body: bytes, content_type: sniffed, requestId });
    return { sha256, mime: sniffed, storage_provider: 'aramo-s3', storage_locator, byte_size: bytes.byteLength };
  }

  async read(input: { storage_locator: string; requestId: string }): Promise<Buffer> {
    return this.storage.getArtifact({ storage_key: input.storage_locator, requestId: input.requestId, maxBytes: LOGO_MAX_BYTES });
  }

  private async readCapped(res: Response, requestId: string): Promise<Buffer> {
    if (res.body === null) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch {
        throw logoError(422, 'logo_fetch_failed', requestId, 'The Tenant profile logo could not be fetched');
      }
      if (chunk.done || chunk.value === undefined) break;
      total += chunk.value.byteLength;
      if (total > LOGO_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw logoError(422, 'logo_too_large', requestId, 'The Tenant profile logo exceeds 1 MB');
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  }
}
