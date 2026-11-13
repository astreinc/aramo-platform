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
