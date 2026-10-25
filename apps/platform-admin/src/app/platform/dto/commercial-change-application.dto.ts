// CCP-A6 — the durable record of one applied change request (CommercialChangeApplication).
export interface CommercialChangeApplicationDto {
  id: string;
  change_request_id: string;
  action_type: string;
  tenant_id: string;
  product_key: string;
  subscription_id: string | null;
  replaced_subscription_id: string | null;
  from_plan_version_id: string | null;
  to_plan_version_id: string | null;
  capabilities: string[];
  capabilities_inserted: string[];
  // CCP-A7 — the capabilities an ENTITLEMENT_REVOKE revoked (empty for every other action).
  capabilities_revoked: string[];
  attempt: number;
  applied_by: string;
  applied_at: string;
}

// CCP-B2-backend — the durable record of one applied catalog change request (CommercialCatalogApplication).
export interface CommercialCatalogApplicationDto {
  id: string;
  change_request_id: string;
  action_type: string;
  plan_id: string;
  plan_version_id: string;
  retired_plan_version_id: string | null;
  provider_price_ref: string | null;
  attempt: number;
  applied_by: string;
  applied_at: string;
}
