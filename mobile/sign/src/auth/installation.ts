// A client-generated installation identifier: DESCRIPTIVE only, never a credential
// (M-A1 §3.3, §3.6). The server's device session id is the authority.
import * as Application from 'expo-application';
import { Platform } from 'react-native';

import { randomId } from '../util/ids';
import { SECURE_KEYS, type SecureKeyValue } from './secureKeyValue';

import type { components } from '../api/generated/auth';

/** Generated from openapi/auth.yaml (NativeDevice). */
export type DeviceDescriptor = components['schemas']['NativeDevice'];

export async function getInstallationId(
  kv: SecureKeyValue,
  newId: () => string = randomId,
): Promise<string> {
  const existing = await kv.getItem(SECURE_KEYS.installationId);
  if (existing) return existing;
  const id = newId();
  await kv.setItem(SECURE_KEYS.installationId, id);
  return id;
}

export async function describeDevice(kv: SecureKeyValue): Promise<DeviceDescriptor> {
  return {
    installation_id: await getInstallationId(kv),
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    app_version: Application.nativeApplicationVersion ?? '0.0.0',
  };
}
