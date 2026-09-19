export { SettingsModule } from './lib/settings.module.js';
export { TenantSettingService } from './lib/tenant-setting.service.js';
export { TenantSettingRepository } from './lib/tenant-setting.repository.js';

export {
  KNOWN_SETTINGS,
  KNOWN_SETTING_KEYS,
  isKnownSettingKey,
  isCompensationDisplayDefault,
  isBoolean,
  isMetricGoalMap,
} from './lib/known-settings.js';
export type {
  KnownSettingKey,
  SettingDefinition,
  SettingValueOf,
  CompensationDisplayDefault,
  MetricGoalMap,
} from './lib/known-settings.js';

export type { TenantSettingsView } from './lib/dto/tenant-settings.view.js';
