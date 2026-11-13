// Aramo India Billing Regions + Razorpay Directive v1.0 (LOCKED) §4.1, §6 — the billing region store:
// reads (list, get), the fail-closed sell decision (sellable) and the write of an approved
// BILLING_REGION_CHANGE (applyChange, run inside the governed apply transaction by its caller).

import { Inject, Injectable, Optional } from '@nestjs/common';

import { isWebBillingProvider } from '../billing-provider.port.js';
import { PrismaService } from '../../prisma/prisma.service.js';

import {
  BILLING_GATEWAY_CONFIGURED,
  PRICE_TAX_MODES,
  type BillingGatewayConfigured,
  type BillingRegionChange,
  type BillingRegionView,
  type BillingSegment,
  type PriceTaxMode,
  type RegionEnableRefusal,
  type RegionSellRefusal,
} from './billing-region.view.js';
import { billingRegionChangeErrors, regionEnableRefusal } from './region-guard.js';

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/** A BILLING_REGION_CHANGE that cannot be applied: an invalid shape, an unknown region, or a G-3 refusal. */
export class BillingRegionChangeError extends Error {
  constructor(
    readonly reason: 'invalid_change' | 'region_not_supported' | RegionEnableRefusal,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'BillingRegionChangeError';
  }
}

/** A stored region row is outside the model (a CHECK the code relies on did not hold): fail closed. */
export class BillingRegionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingRegionIntegrityError';
  }
}

interface RegionRow {
  country: string;
  gateway: string;
  currency: string;
  enabled: boolean;
  personal_web_enabled: boolean;
  business_web_enabled: boolean;
  price_tax_mode: string;
  selling_entity: { id: string; key: string; display_name: string; legal_name: string; country: string; active: boolean };
}

const INCLUDE = { selling_entity: true } as const;

function toView(r: RegionRow): BillingRegionView {
  if (!isWebBillingProvider(r.gateway)) throw new BillingRegionIntegrityError(`billing region ${r.country} has gateway ${r.gateway}`);
  if (!(PRICE_TAX_MODES as readonly string[]).includes(r.price_tax_mode)) throw new BillingRegionIntegrityError(`billing region ${r.country} has price_tax_mode ${r.price_tax_mode}`);
  const e = r.selling_entity;
  return {
    country: r.country,
    gateway: r.gateway,
    currency: r.currency,
    enabled: r.enabled,
    personal_web_enabled: r.personal_web_enabled,
    business_web_enabled: r.business_web_enabled,
    price_tax_mode: r.price_tax_mode as PriceTaxMode,
    selling_entity: { id: e.id, key: e.key, display_name: e.display_name, legal_name: e.legal_name, country: e.country, active: e.active },
  };
}

const ISO2 = /^[A-Z]{2}$/;
const normalCountry = (c: string | null | undefined): string | null => {
  const v = (c ?? '').trim().toUpperCase();
  return ISO2.test(v) ? v : null;
};

@Injectable()
export class BillingRegionService {
  private readonly gatewayConfigured: BillingGatewayConfigured;

  constructor(
    private readonly prisma: PrismaService,
    // G-2 — absent binding: no gateway counts as configured (fail closed).
    @Optional() @Inject(BILLING_GATEWAY_CONFIGURED) gatewayConfigured?: BillingGatewayConfigured,
  ) {
    this.gatewayConfigured = gatewayConfigured ?? (() => false);
  }

  async list(): Promise<BillingRegionView[]> {
    const rows = await this.prisma.billingRegion.findMany({ include: INCLUDE, orderBy: { country: 'asc' } });
    return rows.map(toView);
  }

  async get(country: string): Promise<BillingRegionView | null> {
    const c = normalCountry(country);
    if (c === null) return null;
    const row = await this.prisma.billingRegion.findUnique({ where: { country: c }, include: INCLUDE });
    return row === null ? null : toView(row);
  }

  /** Whether the gateway of a region is configured now (G-2). */
  gatewayIsConfigured(region: Pick<BillingRegionView, 'gateway'>): boolean {
    try {
      return this.gatewayConfigured(region.gateway) === true;
    } catch {
      return false;
    }
  }

  /** Fail-closed: null country, unknown region, region off, segment off, or gateway not configured ⇒ refusal. */
  async sellable(country: string | null, segment: BillingSegment): Promise<{ ok: true; region: BillingRegionView } | { ok: false; reason: RegionSellRefusal }> {
    const c = normalCountry(country);
    if (c === null) return { ok: false, reason: 'region_not_supported' };
    let region: BillingRegionView | null;
    try {
      region = await this.get(c);
    } catch (e) {
      if (e instanceof BillingRegionIntegrityError) return { ok: false, reason: 'region_not_supported' };
      throw e;
    }
    if (region === null) return { ok: false, reason: 'region_not_supported' };
    if (!region.enabled) return { ok: false, reason: 'region_disabled' };
    const segmentOn = segment === 'PERSONAL' ? region.personal_web_enabled : segment === 'BUSINESS' ? region.business_web_enabled : false;
    if (!segmentOn) return { ok: false, reason: 'segment_disabled' };
    // The G-3 conditions are re-checked at sale time: a region left ON whose entity was later
    // deactivated (or a Razorpay region whose price tax mode is UNSET) does not sell.
    const refusal = regionEnableRefusal(region, this.gatewayIsConfigured(region));
    if (refusal === 'gateway_not_configured') return { ok: false, reason: 'gateway_not_configured' };
    if (refusal !== null) return { ok: false, reason: 'region_disabled' };
    return { ok: true, region };
  }

  /**
   * Q3 — writes an approved BILLING_REGION_CHANGE. Re-validates the shape, refuses an unknown region, and
   * enforces G-3 whenever the resulting region is ON. Runs in `tx` (the governed apply transaction) when
   * given, else in its own transaction. `actor` is recorded as the region's updated_by.
   */
  async applyChange(change: BillingRegionChange, actor: string, tx?: Tx): Promise<BillingRegionView> {
    const errors = billingRegionChangeErrors(change as unknown as Record<string, unknown>);
    if (errors.length > 0) throw new BillingRegionChangeError('invalid_change', `invalid billing region change: ${errors.join('; ')}`, errors);
    if (actor.trim() === '') throw new BillingRegionChangeError('invalid_change', 'the actor is required');
    const run = async (db: Tx): Promise<BillingRegionView> => {
      const row = await db.billingRegion.findUnique({ where: { country: change.country }, include: INCLUDE });
      if (row === null) throw new BillingRegionChangeError('region_not_supported', `no billing region ${change.country}`);
      const current = toView(row);
      const e = change.selling_entity ?? {};
      const next: BillingRegionView = {
        ...current,
        enabled: change.enabled ?? current.enabled,
        personal_web_enabled: change.personal_web_enabled ?? current.personal_web_enabled,
        business_web_enabled: change.business_web_enabled ?? current.business_web_enabled,
        price_tax_mode: change.price_tax_mode ?? current.price_tax_mode,
        selling_entity: {
          ...current.selling_entity,
          display_name: e.display_name ?? current.selling_entity.display_name,
          legal_name: e.legal_name ?? current.selling_entity.legal_name,
          active: e.active ?? current.selling_entity.active,
        },
      };
      if (next.enabled) {
        const refusal = regionEnableRefusal(next, this.gatewayIsConfigured(next));
        if (refusal !== null) throw new BillingRegionChangeError(refusal, `billing region ${next.country} may not be ON: ${refusal}`);
      }
      const at = new Date();
      if (change.selling_entity !== undefined) {
        await db.sellingEntity.update({
          where: { id: current.selling_entity.id },
          data: {
            ...(e.display_name !== undefined ? { display_name: e.display_name } : {}),
            ...(e.legal_name !== undefined ? { legal_name: e.legal_name } : {}),
            ...(e.registration !== undefined ? { registration: e.registration } : {}),
            ...(e.active !== undefined ? { active: e.active } : {}),
            updated_at: at,
          },
        });
      }
      const updated = await db.billingRegion.update({
        where: { country: change.country },
        data: {
          enabled: next.enabled,
          personal_web_enabled: next.personal_web_enabled,
          business_web_enabled: next.business_web_enabled,
          price_tax_mode: next.price_tax_mode,
          updated_by: actor,
          updated_at: at,
        },
        include: INCLUDE,
      });
      return toView(updated);
    };
    return tx !== undefined ? run(tx) : this.prisma.$transaction(run);
  }
}
