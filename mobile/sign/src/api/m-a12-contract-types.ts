// HAND-WRITTEN, TEMPORARY: the M-A12 routes and fields that openapi/sign.yaml does not
// carry yet (agents A and B build them concurrently). Shapes follow the M-A12 build
// contract (scratchpad m-a12-contract.md §1–§4) field for field. When the orchestrator
// regenerates src/api/generated/sign.ts, these aliases are replaced by the generated
// types and this file is deleted. Nothing here is policy: the screens render what the
// server decided.

// ── §1 Self-sign ─────────────────────────────────────────────────────────────

export type EnvelopeMode = 'standard' | 'self';

/** Extra fields of the envelope views and sender list rows (§1). */
export interface SelfSignEnvelopeFields {
  readonly mode?: EnvelopeMode;
  /** The caller is a recipient bound to them with can_sign ("Sign now"). */
  readonly can_self_sign_now?: boolean;
}

// ── §2 Text layer ────────────────────────────────────────────────────────────

/** One word; the box is normalised to 0..1 of the page, origin top-left. */
export interface TextLayerWord {
  readonly t: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface TextLayerPage {
  /** 1-based page number. */
  readonly page: number;
  readonly words: readonly TextLayerWord[];
}

export interface TextLayer {
  readonly document_id: string;
  readonly pages: readonly TextLayerPage[];
}

// ── §3 Profile, settings, app issues, template favorites ─────────────────────

export interface SignProfile {
  readonly display_name: string;
  readonly title?: string | null;
  readonly company?: string | null;
  readonly address_line1?: string | null;
  readonly address_line2?: string | null;
  readonly city?: string | null;
  readonly region?: string | null;
  readonly postal_code?: string | null;
  /** ISO 3166-1 alpha-2. */
  readonly country?: string | null;
  /** E.164. */
  readonly phone?: string | null;
}

export type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD';
export type FieldSize = 'S' | 'M' | 'L';

export interface SignSettings {
  readonly date_format: DateFormat;
  readonly default_field_size: FieldSize;
}

export interface AppIssueReport {
  readonly message: string;
  readonly app_version: string;
  readonly os: 'ios' | 'android';
  readonly os_version: string;
  readonly device_model: string;
  readonly screen?: string;
}

export interface TemplateListExtras {
  readonly favorite?: boolean;
  readonly ownership?: 'mine' | 'shared';
}

// ── §4 Billing and store ─────────────────────────────────────────────────────

export type StorePlatform = 'ios' | 'android';
export type StoreInterval = 'MONTH' | 'YEAR';

export interface StoreProduct {
  readonly platform: StorePlatform;
  readonly product_id: string;
  readonly interval: StoreInterval;
}

export interface RegionalPrice {
  readonly country: string;
  readonly currency: string;
  readonly amount_minor: number;
  readonly interval: string;
}

/** Extra fields of each GET /v1/sign/billing/plans item. */
export interface BillingPlanStoreFields {
  readonly store_products?: readonly StoreProduct[];
  readonly regional_price?: RegionalPrice | null;
}

export type ManagedBy = 'STRIPE' | 'APP_STORE' | 'GOOGLE_PLAY';

export type StorePurchaseBlockReason =
  | 'store_billing_disabled'
  | 'not_billing_manager'
  | 'store_purchase_seats_unsupported'
  | 'billing_managed_elsewhere';

/** Extra fields of GET /v1/sign/billing/account. */
export interface BillingAccountStoreFields {
  readonly managed_by?: ManagedBy | null;
  readonly store_purchase_eligible?: boolean;
  readonly store_purchase_block_reason?: StorePurchaseBlockReason | null;
  /** The store subscription-management deep link, or the web URL. */
  readonly manage_url?: string | null;
}

export interface StoreIntentRequest {
  readonly platform: StorePlatform;
  readonly product_id: string;
}

export interface StoreIntent {
  readonly intent_id: string;
  /** iOS appAccountToken; Android obfuscatedAccountId. */
  readonly app_account_token: string;
}

export interface StoreVerifyRequest {
  readonly platform: StorePlatform;
  readonly product_id: string;
  readonly intent_id: string;
  /** iOS: the signed JWS transaction. */
  readonly signed_transaction?: string;
  /** Android: the purchase token. */
  readonly purchase_token?: string;
}

export interface StoreRestoreRequest {
  readonly platform: StorePlatform;
  readonly signed_transactions?: readonly string[];
  readonly purchase_tokens?: readonly string[];
}
