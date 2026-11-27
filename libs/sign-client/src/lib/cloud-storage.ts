// SIGN-FREE-PARITY-1 S6 (FP-R7) — cloud storage import and export: the provider list, the
// names shown on screen, the launch keys and the copy, in ONE place for the server
// (sign-service, libs/sign-cloud-storage), apps/sign-web and mobile/sign. Which providers a
// user may use is decided by the server only: the sender context's `cloud_storage` list
// (launch key AVAILABLE and the provider's OAuth app configured). A client never decides it.

export const CLOUD_PROVIDERS = ['google_drive', 'onedrive', 'dropbox', 'box'] as const;
export type CloudProviderId = (typeof CLOUD_PROVIDERS)[number];

/** The provider's name on screen. */
export const CLOUD_PROVIDER_LABELS: Readonly<Record<CloudProviderId, string>> = {
  google_drive: 'Google Drive',
  onedrive: 'OneDrive',
  dropbox: 'Dropbox',
  box: 'Box',
};

/** The launch switch of each provider (libs/subscription feature-availability.ts). */
export const CLOUD_PROVIDER_FEATURE_KEYS: Readonly<Record<CloudProviderId, string>> = {
  google_drive: 'sign.cloud_google_drive',
  onedrive: 'sign.cloud_onedrive',
  dropbox: 'sign.cloud_dropbox',
  box: 'sign.cloud_box',
};

/** The folder a signed copy is saved to when the user does not choose one. */
export const CLOUD_EXPORT_FOLDER = 'Aramo Sign';

export function isCloudProvider(v: unknown): v is CloudProviderId {
  return typeof v === 'string' && (CLOUD_PROVIDERS as readonly string[]).includes(v);
}

/** The providers the server offers this user (sender context `cloud_storage`), in display order. */
export function cloudProvidersOf(context: unknown): CloudProviderId[] {
  const raw = context !== null && typeof context === 'object' ? (context as { cloud_storage?: unknown }).cloud_storage : undefined;
  if (!Array.isArray(raw)) return [];
  return CLOUD_PROVIDERS.filter((p) => raw.includes(p));
}

/** The file name of a signed copy (the same name as the web download). */
export function signedCopyName(title: string): string {
  const t = title.trim().length > 0 ? title.trim() : 'Document';
  return `${t} (signed).pdf`;
}

/** The result the server adds to the return address after a connect (`?cloud_storage=…&provider=…`). */
export type CloudConnectResult = { readonly status: 'connected' | 'cancelled' | 'failed'; readonly provider: CloudProviderId | null };

function queryParam(search: string, name: string): string | null {
  const q = search.startsWith('?') ? search.slice(1) : search;
  for (const part of q.split('&')) {
    const eq = part.indexOf('=');
    const k = eq < 0 ? part : part.slice(0, eq);
    if (k !== name) continue;
    try {
      return decodeURIComponent((eq < 0 ? '' : part.slice(eq + 1)).replace(/\+/g, ' '));
    } catch {
      return null;
    }
  }
  return null;
}

/** Read the connect result from a return address's query (web) or the app's return link. */
export function cloudConnectResultOf(search: string): CloudConnectResult | null {
  const q = search.includes('?') ? search.slice(search.indexOf('?') + 1) : search;
  const status = queryParam(q, 'cloud_storage');
  if (status !== 'connected' && status !== 'cancelled' && status !== 'failed') return null;
  const provider = queryParam(q, 'provider');
  return { status, provider: isCloudProvider(provider) ? provider : null };
}

export const CLOUD_STORAGE_COPY = {
  settings_title: 'Connected storage',
  settings_intro: 'Connect a cloud storage account to pick documents to send and to save signed copies. Aramo Sign only reads the files you choose and only adds files you save.',
  connect: 'Connect',
  disconnect: 'Disconnect',
  disconnect_confirm: 'Disconnect this account? Aramo Sign will no longer reach its files.',
  not_connected: 'Not connected',
  from_cloud: 'From cloud storage',
  choose_provider: 'Choose where your document is',
  choose_file: 'Choose a document',
  search_placeholder: 'Search files',
  empty_folder: 'No PDF files here.',
  no_results: 'No files match your search.',
  back_to_folder: 'Back',
  save_to: (provider: CloudProviderId) => `Save to ${CLOUD_PROVIDER_LABELS[provider]}`,
  save_folder_default: `Saves to the “${CLOUD_EXPORT_FOLDER}” folder.`,
  saved: (provider: CloudProviderId, folder: string) => `Saved to ${CLOUD_PROVIDER_LABELS[provider]} in “${folder}”.`,
  connected: (provider: CloudProviderId) => `${CLOUD_PROVIDER_LABELS[provider]} is connected.`,
  cancelled: 'Connecting was cancelled.',
  failed: 'The account couldn’t be connected. Try again.',
  connect_first: (provider: CloudProviderId) => `Connect ${CLOUD_PROVIDER_LABELS[provider]} first.`,
} as const;

/** Refusal copy keyed by details.reason (merged into REFUSAL_COPY). */
export const CLOUD_STORAGE_REFUSAL_COPY = {
  cloud_not_connected: 'Connect this cloud storage account first, in Settings.',
  cloud_reconnect_required: 'Your cloud storage account needs to be connected again. Open Settings and connect it.',
  cloud_provider_unavailable: 'Your cloud storage didn’t answer. Try again in a moment.',
  cloud_file_not_found: 'That file is no longer there. Choose another file.',
  cloud_not_a_file: 'Choose a file, not a folder.',
  cloud_file_too_large: 'This file is larger than 25 MB. Choose a smaller file.',
  cloud_folder_not_writable: 'Aramo Sign can’t save to that folder. Choose another folder.',
} as const;

/** Copy for a provider's refused launch key (ESIGN_FEATURE_NOT_AVAILABLE details.feature_key). */
export const CLOUD_FEATURE_COPY: Readonly<Record<string, string>> = Object.fromEntries(
  CLOUD_PROVIDERS.map((p) => [CLOUD_PROVIDER_FEATURE_KEYS[p], `${CLOUD_PROVIDER_LABELS[p]} isn’t available yet.`]),
);
