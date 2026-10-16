// Display labels for integration vocabularies: the tenant AI model provider key
// (llm-providers-api LlmProvider, also echoed on screening generation plans), the
// connector provider_key, and the connector last_error_code. Kept apart from the API
// clients so specs that mock them still get the real labels. Unknown keys / codes
// degrade to sentence case.
import { codeLabel } from '../ui/code-label';

import type { LlmProvider } from './llm-providers-api';

export const LLM_PROVIDER_LABELS: Readonly<Record<LlmProvider, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};
export function llmProviderLabel(code: string): string {
  return codeLabel(LLM_PROVIDER_LABELS, code);
}

// Connector connection provider_key (libs/integration registered adapters + the
// communications / Microsoft providers that share the connection table).
export const CONNECTOR_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  fieldglass: 'SAP Fieldglass',
  beeline: 'Beeline',
  workday: 'Workday',
  zoom_phone: 'Zoom Phone',
  teams_phone: 'Teams Phone',
  microsoft_teams: 'Microsoft Teams',
  microsoft_graph: 'Microsoft 365',
};
export function connectorProviderLabel(code: string): string {
  return codeLabel(CONNECTOR_PROVIDER_LABELS, code);
}

// Connector connection last_error_code (libs/integration connector-execution +
// the requisition lifecycle poll).
export const CONNECTOR_ERROR_CODE_LABELS: Readonly<Record<string, string>> = {
  CONNECTOR_CONFIGURATION_INVALID: 'Configuration is invalid',
  CONNECTOR_EXECUTION_UNAVAILABLE: 'Provider unavailable',
  CONNECTOR_EXECUTION_FAILED: 'Sync failed',
  LIFECYCLE_POLL_FAILED: 'Status sync failed',
};
export function connectorErrorCodeLabel(code: string): string {
  return codeLabel(CONNECTOR_ERROR_CODE_LABELS, code);
}
