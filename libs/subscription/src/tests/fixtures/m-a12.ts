import { resolve } from 'node:path';

// Aramo Sign Mobile M-A12 W1-G — ONE shared helper for the gated specs that apply a fixed
// migration set (CLAUDE.md: one helper, not N duplicated edits). The store-billing columns
// (TenantSubscription.store_*, PlanVersionPrice.interval, CheckoutIntent.store_product_id) are
// read by the Prisma client on every query, so each such set applies this right after A5.

/** The M-A12 store-billing migration (depends only on the lifecycle and A5 tables). */
export const M_A12_STORE_MIGRATION = resolve(__dirname, '../../../prisma/migrations/20261104100000_sign_store_billing/migration.sql');

/**
 * Sign Business per-seat pricing (directive 00225bad) — the seat columns (TenantSubscription.seat_quantity,
 * seat_pending_quantity, CheckoutIntent.seat_quantity) are read by the Prisma client on every query too, so
 * each fixed set applies this schema migration right after the M-A12 one (never its catalog data part).
 */
export const SIGN_BUSINESS_PER_SEAT_SCHEMA_MIGRATION = resolve(__dirname, '../../../prisma/migrations/20261108100000_sign_business_per_seat/migration.sql');

/**
 * India Billing Regions + Razorpay (directive v1.0 LOCKED, Q9) — TenantBillingAccount is keyed
 * (tenant_id, provider), and the lifecycle upserts on that key. A fixed set that reaches checkout applies
 * this fixture (the account part of 20261113100000_india_billing_regions, verbatim) after the seat schema.
 */
export const INDIA_BILLING_ACCOUNT_KEY_FIXTURE = resolve(__dirname, './india-billing-account-key.sql');

/**
 * Sign Monthly and Annual-Commitment Pricing (directive v1.0 LOCKED 2026-11-15) — the `term` columns
 * (TenantSubscription.term, CheckoutIntent.term, PlanVersionPrice.term) are read by the Prisma client on every
 * query, so each fixed set applies this migration last. It touches only tables those sets already have
 * (PlanVersion, PlanVersionPrice, CheckoutIntent, TenantSubscription), so the migration itself is applied whole.
 */
export const SIGN_BILLING_TERMS_MIGRATION = resolve(__dirname, '../../../prisma/migrations/20261115100000_sign_billing_terms/migration.sql');

/**
 * CCP-PERSONAL-ARRANGED-1 (P-2) — TenantSubscription.arrangement is read by the Prisma client on every query,
 * so each fixed set applies this migration right after the billing-terms one. It adds one nullable column
 * to a table those sets already have, so it is applied whole.
 */
export const CCP_PERSONAL_ARRANGED_MIGRATION = resolve(__dirname, '../../../prisma/migrations/20261124100000_ccp_personal_arranged_1_arrangement/migration.sql');
