import { describe, expect, it, vi } from 'vitest';
import type { RenderBlock, RenderModel } from '@aramo/documents-rendering';

import { ExecutionService } from '../lib/execution.service.js';
import type { CertificateBranding, SignBrandingPort } from '../lib/ports/sign-branding.port.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.10 — the organization's branding
// on the execution certificate: unbound / null keeps exactly the pre-branding render model; a
// logo becomes the letterhead (with the primary colour as its rule); a name without a logo is
// an "Organization:" line; a branded render that fails falls back to the default certificate.

const BLOCKS: RenderBlock[] = [{ type: 'HEADING', text: 'Envelope e1' }];
const BASE: RenderModel = { render_schema_version: 'v1', title: 'Execution Certificate', blocks: BLOCKS };
const OUT = { bytes: new Uint8Array([1]), sha256: 's', page_count: 1, provenance: {} };

function svc(branding?: SignBrandingPort, fail = false) {
  const rendering = {
    renderGenerated: vi.fn(async (m: RenderModel) => {
      if (fail && m.letterhead !== undefined) throw new Error('bad image');
      return OUT;
    }),
  };
  const s = new ExecutionService({} as never, {} as never, rendering as never, {} as never, undefined, undefined, undefined, undefined, undefined, branding);
  const priv = s as unknown as {
    renderCertificate: (b: RenderBlock[], br: CertificateBranding | null) => Promise<unknown>;
    certificateBranding: (t: string) => Promise<CertificateBranding | null>;
  };
  return { rendering, priv };
}

const LOGO = { bytes: new Uint8Array([9]), format: 'PNG' as const, sha256: 'f'.repeat(64) };

describe('ExecutionService — certificate branding', () => {
  it('no branding: exactly the default model', async () => {
    const { rendering, priv } = svc();
    await priv.renderCertificate(BLOCKS, null);
    expect(rendering.renderGenerated).toHaveBeenCalledWith(BASE);
    expect(await priv.certificateBranding('t')).toBeNull();
  });

  it('a logo becomes the letterhead with the display name and the primary colour rule', async () => {
    const { rendering, priv } = svc();
    await priv.renderCertificate(BLOCKS, { display_name: 'Acme Staffing', primary_color: '#0A7F3F', logo: LOGO });
    expect(rendering.renderGenerated).toHaveBeenCalledWith({
      ...BASE,
      letterhead: { image_bytes: LOGO.bytes, image_format: 'PNG', image_sha256: LOGO.sha256, name: 'Acme Staffing', rule_color: '#0A7F3F' },
    });
  });

  it('a display name without a logo is an Organization line above the content', async () => {
    const { rendering, priv } = svc();
    await priv.renderCertificate(BLOCKS, { display_name: 'Acme Staffing', primary_color: null, logo: null });
    expect(rendering.renderGenerated).toHaveBeenCalledWith({ ...BASE, blocks: [{ type: 'TEXT', text: 'Organization: Acme Staffing' }, ...BLOCKS] });
  });

  it('a branded render that fails falls back to the default certificate', async () => {
    const { rendering, priv } = svc(undefined, true);
    await expect(priv.renderCertificate(BLOCKS, { display_name: null, primary_color: null, logo: LOGO })).resolves.toBe(OUT);
    expect(rendering.renderGenerated).toHaveBeenLastCalledWith(BASE);
  });

  it('a branding lookup that throws never fails completion', async () => {
    const port: SignBrandingPort = { certificateBranding: vi.fn(async () => Promise.reject(new Error('db down'))) };
    expect(await svc(port).priv.certificateBranding('t')).toBeNull();
  });
});
