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
  attempt: number;
  applied_by: string;
  applied_at: string;
}
