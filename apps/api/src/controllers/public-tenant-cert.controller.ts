import { Controller, Get, HttpStatus, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  TenantService,
  extractTenantSlugFromHost,
} from '@aramo/identity';

// Subdomain-Identity Directive A (§3) — the PUBLIC cert-eligibility ask-endpoint.
//
// GET /v1/tenants/cert-eligible?domain=<host>
//
// Caddy's on-demand TLS calls this BEFORE issuing a per-host certificate
// (Caddyfile `on_demand_tls { ask … }`): it forwards the requested host as the
// `domain` query param and issues a cert ONLY on a 2xx. So this endpoint is the
// gate that makes the tenant table the single source of truth for "is this a
// valid subdomain": a host gets a cert iff a real, ACTIVE tenant owns its slug.
// Onboarding a tenant (inserting the row with a slug) is therefore what makes
// the subdomain cert-eligible — a DATA op, never an infra op.
//
// DELIBERATELY UN-GUARDED (mirrors PublicInvitationController): Caddy calls this
// before any TLS/session exists, so there can be no JWT — there is NO @UseGuards
// here. It is a pure read with NO side effects and leaks NOTHING beyond the
// status code (no tenant details in the body): a bare { eligible } boolean that
// only restates the 200/404 the caller already learns. Revealing 200-vs-404 for
// a slug is acceptable by design — subdomains are semi-public (they appear in
// URLs and certs). It must do nothing but the slug lookup: it never echoes the
// input back into a fetch and never returns tenant data (no SSRF / enumeration
// surface beyond existence).
//
// The host is anchored to the platform root domain (APP_ROOT_DOMAIN, default
// aramo.ai) by extractTenantSlugFromHost, so the endpoint can only ever vouch
// for true <slug>.aramo.ai subdomains — never `<slug>.attacker.com`. A malformed
// host, the bare apex, a multi-label host, or an unknown/disabled slug all map
// to 404 (not-eligible), never a 4xx/5xx error envelope.
const APP_ROOT_DOMAIN = process.env['APP_ROOT_DOMAIN'] ?? 'aramo.ai';

@Controller('v1/tenants')
export class PublicTenantCertController {
  constructor(private readonly tenants: TenantService) {}

  @Get('cert-eligible')
  async certEligible(
    @Query('domain') domain: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ eligible: boolean }> {
    const eligible = await this.isEligible(domain);
    res.status(eligible ? HttpStatus.OK : HttpStatus.NOT_FOUND);
    return { eligible };
  }

  // Extract the single slug label under the apex, then confirm a real active
  // tenant owns it. Any failure to parse (missing/empty/foreign/multi-label
  // host) short-circuits to not-eligible WITHOUT a DB hit.
  private async isEligible(domain: string | undefined): Promise<boolean> {
    if (typeof domain !== 'string' || domain.length === 0) {
      return false;
    }
    const slug = extractTenantSlugFromHost(domain, APP_ROOT_DOMAIN);
    if (slug === null) {
      return false;
    }
    const tenant = await this.tenants.findActiveBySlug(slug);
    return tenant !== null;
  }
}
