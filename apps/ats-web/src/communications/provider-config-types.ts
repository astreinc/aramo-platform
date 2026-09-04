// COMM-C1 — FE mirror of the communications provider CONFIGURATION contracts
// (openapi/ats.yaml CommunicationProviderConfig* + CommunicationConnectionTestResult).
// Hand-mirrored (apps/ats-web must not import @aramo/communications — a forbidden
// domain edge); a BE shape change surfaces as a failing build here, not silent
// runtime drift. SECRET-FREE: no token/secret/secret_ref/AWS identifier appears
// in any of these shapes — only whether a credential exists.

export type CommunicationConfigurationState =
  | 'not_configured'
  | 'configured'
  | 'active'
  | 'degraded'
  | 'disabled';

export type CommunicationConnectionStatus =
  | 'disconnected'
  | 'configured'
  | 'active'
  | 'degraded'
  | 'disabled';

export type CommunicationCapabilityExecution = 'available' | 'not_available';

export interface CommunicationCapabilityState {
  readonly voice: { readonly supported: boolean; readonly execution: CommunicationCapabilityExecution };
  readonly sms: { readonly supported: boolean; readonly execution: CommunicationCapabilityExecution };
}

export interface CommunicationProviderConfig {
  readonly provider_key: string;
  readonly display_name: string;
  readonly connection_id: string | null;
  readonly configuration_state: CommunicationConfigurationState;
  readonly status: CommunicationConnectionStatus | null;
  readonly credential_configured: boolean;
  readonly provider_account_id: string | null;
  readonly last_successful_at: string | null;
  readonly last_error_code: string | null;
  readonly recruiter_mapping_count: number;
  readonly capabilities: CommunicationCapabilityState;
}

export interface CommunicationConnectionTestResult {
  readonly provider_key: string;
  readonly healthy: boolean;
  readonly detail: string | null;
  readonly checked: 'structural';
}

// Write-only credential bundle (configure/update). NEVER read back in any GET.
export interface ZoomCredentialInput {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly token_type?: string;
  readonly scope?: string;
  readonly expires_at?: string;
  readonly account_id?: string;
}
