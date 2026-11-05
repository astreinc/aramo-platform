// Remaining-Work Consolidated Directive (32e5e3e1) A4 — the account screen's way to the billing
// settings. Cancelling a subscription is done on the web (Settings → Billing → "Cancel
// subscription"); the app only links there. Shown to someone who may manage billing, while the
// account has a provider-billed plan. No purchase is offered or linked from the app.
import type { BillingAccount } from '../inbox/types';
import { PRODUCTION_API_BASE_URL } from '../../config/env';

export const BILLING_SETTINGS_URL = `${PRODUCTION_API_BASE_URL}/sign/settings/billing`;
export const PERSONAL_BILLING_SETTINGS_URL = `${PRODUCTION_API_BASE_URL}/personal/settings/billing`;
export const MANAGE_BILLING_LABEL = 'Manage billing or cancel';

/** The web billing settings link for this account, or null when there is nothing to manage. */
export function billingSettingsLink(account: BillingAccount | null | undefined): string | null {
  if (account == null || !account.can_manage_billing) return null;
  // M-A12 W1-G — a store-billed plan is managed in the store (Plans › Manage subscription).
  const managedBy = (account as { managed_by?: string | null }).managed_by;
  if (managedBy === 'APP_STORE' || managedBy === 'GOOGLE_PLAY') return null;
  const sub = account.subscription;
  if (sub == null || !sub.billing_managed || sub.ended_at != null) return null;
  return account.tenant_kind === 'PERSONAL' ? PERSONAL_BILLING_SETTINGS_URL : BILLING_SETTINGS_URL;
}
