// The ONLY persistence for credentials: iOS Keychain / Android Keystore through
// expo-secure-store (directive §3.7). `THIS_DEVICE_ONLY` keeps items out of backups
// and device migration.
import * as SecureStore from 'expo-secure-store';

export interface SecureKeyValue {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const secureKeyValue: SecureKeyValue = {
  getItem: (key) => SecureStore.getItemAsync(key, OPTIONS),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, OPTIONS),
  deleteItem: (key) => SecureStore.deleteItemAsync(key, OPTIONS),
};

/** Every SecureStore key the app uses, in one place (README "Storage"). */
export const SECURE_KEYS = {
  accessToken: 'aramo.sign.access_token',
  refreshToken: 'aramo.sign.refresh_token',
  sessionMeta: 'aramo.sign.session_meta',
  installationId: 'aramo.sign.installation_id',
  storageKey: 'aramo.sign.storage_key',
  biometricConfirm: 'aramo.sign.pref.biometric_confirm',
  biometricUnlock: 'aramo.sign.pref.biometric_unlock',
  localOwner: 'aramo.sign.local_owner',
} as const;
