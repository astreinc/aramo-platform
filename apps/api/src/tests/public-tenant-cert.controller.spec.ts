import { describe, expect, it, vi } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import type { TenantService } from '@aramo/identity';

import { PublicTenantCertController } from '../controllers/public-tenant-cert.controller.js';

// Subdomain-Identity Directive A (§3) — the public cert-eligibility ask-endpoint.
// Proves the three outcomes Caddy's on-demand TLS depends on: 200 for a real
// active tenant subdomain, 404 for an unknown slug, 404 for a malformed/foreign
// host (with NO DB hit on the short-circuit paths — the apex anchor).
//
// APP_ROOT_DOMAIN is read at module load; the tests use the default (aramo.ai).

interface FakeRes {
  status: ReturnType<typeof vi.fn>;
}

function makeRes(): { res: Response; status: FakeRes['status'] } {
  const status = vi.fn().mockReturnThis();
  return { res: { status } as unknown as Response, status };
}

function makeController(found: { id: string; slug: string } | null) {
  const findActiveBySlug = vi.fn().mockResolvedValue(found);
  const tenants = { findActiveBySlug } as unknown as TenantService;
  return {
    controller: new PublicTenantCertController(tenants),
    findActiveBySlug,
  };
}

describe('PublicTenantCertController — cert-eligible ask-endpoint', () => {
  it('200 + eligible:true for a real active tenant subdomain', async () => {
    const { controller, findActiveBySlug } = makeController({
      id: 't1',
      slug: 'astre',
    });
    const { res, status } = makeRes();

    const out = await controller.certEligible('astre.aramo.ai', res);

    expect(out).toEqual({ eligible: true });
    expect(status).toHaveBeenCalledWith(HttpStatus.OK);
    // looked up by the extracted, lowercased label
    expect(findActiveBySlug).toHaveBeenCalledWith('astre');
  });

  it('404 + eligible:false for a host whose slug is not a tenant', async () => {
    const { controller, findActiveBySlug } = makeController(null);
    const { res, status } = makeRes();

    const out = await controller.certEligible('notatenant.aramo.ai', res);

    expect(out).toEqual({ eligible: false });
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(findActiveBySlug).toHaveBeenCalledWith('notatenant');
  });

  it('404 with NO DB hit for a foreign host (the SSRF anchor)', async () => {
    const { controller, findActiveBySlug } = makeController({
      id: 't1',
      slug: 'astre',
    });
    const { res, status } = makeRes();

    // slug 'astre' exists, but the host is NOT under the apex → never asks.
    const out = await controller.certEligible('astre.attacker.com', res);

    expect(out).toEqual({ eligible: false });
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(findActiveBySlug).not.toHaveBeenCalled();
  });

  it('404 with NO DB hit for malformed / missing / multi-label hosts', async () => {
    for (const host of [undefined, '', 'aramo.ai', 'a.b.aramo.ai', 'localhost']) {
      const { controller, findActiveBySlug } = makeController({
        id: 't1',
        slug: 'astre',
      });
      const { res, status } = makeRes();

      const out = await controller.certEligible(host, res);

      expect(out).toEqual({ eligible: false });
      expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(findActiveBySlug).not.toHaveBeenCalled();
    }
  });
});
