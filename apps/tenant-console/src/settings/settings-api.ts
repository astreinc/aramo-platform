// Settings API client — wraps the S1 GET + S2 PUT endpoints.
// Endpoints (backend; S5a does NOT modify them):
//   GET /v1/tenant/settings           -> TenantSettingsView
//   PUT /v1/tenant/settings/:key      -> { key, value, previous_value }

import { apiClient } from '../api/client';

import type {
  TenantSettingSetResult,
  TenantSettingValue,
  TenantSettingsView,
} from './types';

export const SETTINGS_PATH = '/v1/tenant/settings';

export async function fetchTenantSettings(): Promise<TenantSettingsView> {
  return apiClient.get<TenantSettingsView>(SETTINGS_PATH);
}

export async function setTenantSetting<K extends keyof TenantSettingsView>(
  key: K,
  value: TenantSettingValue<K>,
): Promise<TenantSettingSetResult<K>> {
  return apiClient.put<TenantSettingSetResult<K>>(
    `${SETTINGS_PATH}/${encodeURIComponent(key)}`,
    { value },
  );
}
