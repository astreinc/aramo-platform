// SIGN-FREE-PARITY-1 S6 — runs under vitest and mobile Jest (globals only).
import {
  CLOUD_PROVIDERS,
  CLOUD_PROVIDER_FEATURE_KEYS,
  CLOUD_STORAGE_COPY,
  cloudConnectResultOf,
  cloudProvidersOf,
  isCloudProvider,
  refusalMessage,
  signedCopyName,
} from '../index.js';

describe('cloud storage providers', () => {
  it('lists the four providers with a launch key each', () => {
    expect([...CLOUD_PROVIDERS]).toEqual(['google_drive', 'onedrive', 'dropbox', 'box']);
    expect(CLOUD_PROVIDER_FEATURE_KEYS.onedrive).toBe('sign.cloud_onedrive');
  });

  it('reads only what the server offers, in display order, ignoring unknown values', () => {
    expect(cloudProvidersOf({ cloud_storage: ['box', 'google_drive', 'ftp'] })).toEqual(['google_drive', 'box']);
    expect(cloudProvidersOf({})).toEqual([]);
    expect(cloudProvidersOf(null)).toEqual([]);
    expect(cloudProvidersOf({ cloud_storage: 'box' })).toEqual([]);
  });

  it('isCloudProvider accepts only a known id', () => {
    expect(isCloudProvider('dropbox')).toBe(true);
    expect(isCloudProvider('Dropbox')).toBe(false);
    expect(isCloudProvider(undefined)).toBe(false);
  });
});

describe('cloudConnectResultOf', () => {
  it('reads the status and provider from a query', () => {
    expect(cloudConnectResultOf('?cloud_storage=connected&provider=onedrive')).toEqual({ status: 'connected', provider: 'onedrive' });
    expect(cloudConnectResultOf('aramosign://cloud-storage?cloud_storage=failed&provider=box')).toEqual({ status: 'failed', provider: 'box' });
  });

  it('is null without a known status; an unknown provider reads as null', () => {
    expect(cloudConnectResultOf('?tab=sent')).toBeNull();
    expect(cloudConnectResultOf('?cloud_storage=weird')).toBeNull();
    expect(cloudConnectResultOf('?cloud_storage=cancelled&provider=x')).toEqual({ status: 'cancelled', provider: null });
  });
});

describe('copy', () => {
  it('names the signed copy like the web download', () => {
    expect(signedCopyName('Offer letter')).toBe('Offer letter (signed).pdf');
    expect(signedCopyName('  ')).toBe('Document (signed).pdf');
  });

  it('maps the cloud refusals and the dark launch keys to plain copy', () => {
    expect(refusalMessage({ code: 'INVALID_REQUEST', reason: 'cloud_reconnect_required' })).toContain('connected again');
    expect(refusalMessage({ code: 'ESIGN_FEATURE_NOT_AVAILABLE', details: { feature_key: 'sign.cloud_box' } })).toBe('Box isn’t available yet.');
    expect(CLOUD_STORAGE_COPY.save_to('google_drive')).toBe('Save to Google Drive');
  });
});
