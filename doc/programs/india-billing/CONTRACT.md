# India Billing Regions + Razorpay: shared build contract

Governing directive: `DIRECTIVE-LOCKED.md` (Aramo-India-Billing-Regions-Razorpay-Directive-v1_0-LOCKED, sha256 aff370e1…410c). This file fixes the **names** every parallel workstream builds against, so the four branches merge cleanly. If a workstream needs to change a name here, it reports a typed divergence; it never renames silently.

Integration branch: `feat/india-billing-razorpay` (base `origin/main` 3fc6e826). Each workstream works on its own branch off this one and is merged back by the executor.

## Provider key
- New literal **`RAZORPAY`** (string; there are no Prisma enums, CHECKs constrain the columns).
- `WEB_BILLING_PROVIDERS = ['STRIPE', 'RAZORPAY'] as const`; `type WebBillingProviderKey = (typeof WEB_BILLING_PROVIDERS)[number]`; `isWebBillingProvider(p)`.
  Exported from `libs/subscription/src/lib/billing/billing-provider.port.ts`, next to `BillingProviderKey` (which becomes `'STRIPE' | 'APP_STORE' | 'GOOGLE_PLAY' | 'RAZORPAY'`).
- `BillingProvider` / `BILLING_PROVIDERS` in `sync/billing-product.ts` gain `RAZORPAY`.

## Database (subscription schema; migration owned by WS-A)
One migration: `libs/subscription/prisma/migrations/20261113100000_india_billing_regions/migration.sql`.

`subscription."SellingEntity"`
| column | type | notes |
|---|---|---|
| id | uuid PK default gen_random_uuid() | |
| key | text UNIQUE NOT NULL | `aramo-us`, `aramo-in` |
| display_name | text NOT NULL | |
| legal_name | text NOT NULL | |
| country | text NOT NULL CHECK `~ '^[A-Z]{2}$'` | |
| registration | jsonb NOT NULL default `'{}'` | abstract registration identifiers (directive §5); data only |
| active | boolean NOT NULL default false | |
| created_at / updated_at | timestamptz | |

`subscription."BillingRegion"`
| column | type | notes |
|---|---|---|
| country | text PK CHECK `~ '^[A-Z]{2}$'` | |
| gateway | text NOT NULL CHECK IN ('STRIPE','RAZORPAY') | |
| currency | text NOT NULL CHECK `~ '^[A-Z]{3}$'` | |
| selling_entity_id | uuid NOT NULL FK SellingEntity(id) | |
| enabled | boolean NOT NULL default false | master switch |
| personal_web_enabled | boolean NOT NULL default false | |
| business_web_enabled | boolean NOT NULL default false | |
| price_tax_mode | text NOT NULL default 'UNSET' CHECK IN ('UNSET','INCLUSIVE','EXCLUSIVE') | |
| updated_by | text NULL | |
| created_at / updated_at | timestamptz | |

Seed (same migration, idempotent):
- SellingEntity `aramo-us` (display "Aramo", legal_name "Aramo", country US, active **true**), `aramo-in` (display "Aramo India", legal_name "Aramo India", country IN, active **false**).
- BillingRegion US: gateway STRIPE, USD, aramo-us, enabled **true**, personal_web_enabled **true**, business_web_enabled **true**, price_tax_mode UNSET.
- BillingRegion IN: gateway RAZORPAY, INR, aramo-in, all switches **false**, UNSET.

Provider CHECK widening (recon R2): every CHECK that lists `('STRIPE','APP_STORE','GOOGLE_PLAY')` adds `'RAZORPAY'`. Of the STRIPE-only CHECKs, `TenantBillingAccount_provider_check` and `BillingProviderCommand_provider_check` become `IN ('STRIPE','RAZORPAY')`. Adjustments, self-service, usage stay STRIPE-only (directive §7). Conditional CHECKs and partial unique indexes that say `provider = 'STRIPE'` for web semantics (`PlanVersionPrice` web pins and interval, `BillingProduct` interval, `CheckoutIntent_store_product_check`, `TenantSubscription_store_ref_check`) treat `RAZORPAY` exactly like `STRIPE`.

`TenantBillingAccount`: primary key becomes `(tenant_id, provider)` (existing rows are all STRIPE; keep `@@unique([provider, account_ref])`).

Commercial action set grows 17 → 18 with **`BILLING_REGION_CHANGE`** (domain `catalog`, requester scope `platform:catalog:draft`); both action_type CHECKs widened in the same migration.

## Region read model (WS-A, `libs/subscription/src/lib/billing/region/`)
```ts
export type BillingSegment = 'PERSONAL' | 'BUSINESS';
export interface BillingRegionView {
  country: string; gateway: WebBillingProviderKey; currency: string;
  enabled: boolean; personal_web_enabled: boolean; business_web_enabled: boolean;
  price_tax_mode: 'UNSET' | 'INCLUSIVE' | 'EXCLUSIVE';
  selling_entity: { id: string; key: string; display_name: string; legal_name: string; country: string; active: boolean };
}
export type RegionSellRefusal = 'region_not_supported' | 'region_disabled' | 'segment_disabled' | 'gateway_not_configured';
export class BillingRegionService {
  list(): Promise<BillingRegionView[]>;
  get(country: string): Promise<BillingRegionView | null>;
  /** Fail-closed: null country, unknown region, region off, segment off, or gateway not configured ⇒ refusal. */
  sellable(country: string | null, segment: BillingSegment): Promise<{ ok: true; region: BillingRegionView } | { ok: false; reason: RegionSellRefusal }>;
}
/** Directive §6 G-3 — whether a region may be switched ON (pure). */
export function regionEnableRefusal(r: BillingRegionView, gatewayConfigured: boolean): null | 'gateway_not_configured' | 'selling_entity_inactive' | 'price_tax_mode_unset';
```
G-3: `price_tax_mode_unset` applies to every region whose gateway is `RAZORPAY` (the US region keeps the existing CCP-C5 state).

## Gateway registry (WS-B, `libs/subscription/src/lib/billing/gateway-registry.ts`)
```ts
export const BILLING_GATEWAY_REGISTRY = Symbol('BILLING_GATEWAY_REGISTRY');
export interface BillingGatewayRegistry {
  billing(p: WebBillingProviderKey): BillingProviderPort;           // throws for an unbound key
  commands(p: WebBillingProviderKey): BillingProviderCommandPort | null;
  seats(p: WebBillingProviderKey): BillingProviderSeatPort | null;
  configured(p: WebBillingProviderKey): boolean;
}
```
`BILLING_PROVIDER_PORT` stays bound to Stripe (the US path is unchanged); new code that must reach Razorpay goes through the registry.

## Country port (WS-D)
```ts
export const BILLING_COUNTRY_PORT = Symbol('BILLING_COUNTRY_PORT');
export interface BillingCountryPort {
  /** Personal: declared_residence of the latest PROVISIONED signup. Business: identity Tenant.country_code. */
  countryOf(tenant_id: string): Promise<{ tenant_kind: 'PERSONAL' | 'BUSINESS' | null; country: string | null }>;
}
```
Declared in `libs/subscription/src/lib/billing/region/billing-country.port.ts` (WS-A creates the file with exactly this content); bound in sign-service by WS-D.

## Razorpay env (WS-B)
`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_API_BASE` (default `https://api.razorpay.com`), `SIGN_RAZORPAY_BILLING_ENABLED` (exactly `1` enables). Readers of the key: only `razorpay-billing.provider.ts` and `sync/razorpay-catalog.writer.ts` via exported `razorpayCredentials()` / `razorpayApiBase()` from the provider file (C5-G-1 pins these). Never logged.

## Webhook
`POST /v1/sign/billing/webhook/razorpay`, header `x-razorpay-signature`, HMAC-SHA256 hex over the raw body. 404 while `SIGN_RAZORPAY_BILLING_ENABLED` is not `1`.

## Console labels
`PROVIDER_LABEL.RAZORPAY = 'Web India (Razorpay)'`; `PROVIDER_LABEL.STRIPE` stays `'Web (Stripe)'`.

## Workstream ownership (disjoint files; shared files are listed under the owner)
- **WS-A schema & region model:** the migration, `schema.prisma`, provider unions (lib, DTOs, OpenAPI enums, platform-web `catalog-api.ts`, mobile generated + hand types via the generator), `commercial-change-request.ts` action set, `region/*` (service, view, pure guard, country port declaration), `subscription.module.ts` provider for `BillingRegionService`, `TenantBillingAccount` code updates.
- **WS-B Razorpay gateway:** `razorpay-wire.ts`, `razorpay-billing.provider.ts`, gateway registry + module bindings, webhook route + inbox routing, lifecycle `syncSubscription` routing, `effectiveProviderPrice`/`resolvePriceToVersion` per provider, store/web mutual exclusion, vocabulary exemption lockstep, C5-G-1 guard, env passthrough + `.env.prod.example` + compose, `api-surface-manifest.json`, OpenAPI webhook path.
- **WS-C catalog sync & console:** `sync/razorpay-catalog.writer.ts`, `billing-product.ts` `eligibleProviders`, `billing-products.service.ts`, `BILLING_REGION_CHANGE` apply service + platform-admin endpoints, console Billing regions page + nav + labels + editor copy.
- **WS-D routing, guards, signup, web UI:** `BILLING_COUNTRY_PORT` binding, checkout/catalog routing by region in `esign-billing.controller.ts` and `subscription-lifecycle.service.ts` `startCheckout`/activation guard, Personal residence + Business country guards, Business IN signup (identity) behind the region, sign-web currency + provider-neutral copy + Aramo manage page.
