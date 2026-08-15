// T8-CONNECTOR-A — connector connection view (frontend mirror). Deliberately
// carries NO secret_ref, AWS identifier, or credential value — only `has_secret`.

export type IntegrationConnectionStatus =
  | 'disconnected'
  | 'configured'
  | 'active'
  | 'degraded'
  | 'disabled';

export interface IntegrationConnectionView {
  readonly id: string;
  readonly tenant_id: string;
  readonly provider_key: string;
  readonly status: IntegrationConnectionStatus;
  readonly has_secret: boolean;
  readonly provider_account_id: string | null;
  readonly last_attempted_at: string | null;
  readonly last_successful_at: string | null;
  readonly last_error_code: string | null;
  readonly last_error_summary: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}
