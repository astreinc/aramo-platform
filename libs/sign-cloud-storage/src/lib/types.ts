import type { CloudProviderId } from '@aramo/sign-client';

export type { CloudProviderId } from '@aramo/sign-client';

/** The fetch this lib calls (the global fetch in production; a mock in tests). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** One entry of a folder listing or a search. */
export interface CloudItem {
  readonly id: string;
  readonly name: string;
  readonly kind: 'folder' | 'file';
  readonly mime_type: string | null;
  readonly size: number | null;
  readonly modified_at: string | null;
}

export interface CloudListPage {
  readonly items: CloudItem[];
  /** Opaque; pass back to get the next page. Null on the last page. */
  readonly next_cursor: string | null;
}

export interface CloudListOptions {
  /** Null = the top of the user's storage. */
  readonly folder_id: string | null;
  /** A file-name search across the user's storage (folders are not searched). */
  readonly query: string | null;
  readonly cursor: string | null;
  /** Folders only (choosing where to save). */
  readonly folders_only: boolean;
  /** File name extensions offered, lower case, without the dot (e.g. ['pdf']). */
  readonly extensions: readonly string[];
}

export interface CloudFileMeta {
  readonly id: string;
  readonly name: string;
  readonly kind: 'folder' | 'file';
  readonly size: number | null;
  readonly mime_type: string | null;
}

export interface CloudFolder {
  readonly id: string;
  readonly name: string;
}

export interface CloudSaved {
  readonly id: string;
  readonly name: string;
  readonly web_url: string | null;
}

export interface CloudAccount {
  /** The account's email (or name) shown under Connected storage. */
  readonly label: string | null;
}

/** One provider's files API, bound to one access token. */
export interface CloudDriveClient {
  readonly provider: CloudProviderId;
  account(): Promise<CloudAccount>;
  list(opts: CloudListOptions): Promise<CloudListPage>;
  metadata(file_id: string): Promise<CloudFileMeta>;
  /** The file's bytes; CloudProviderError('too_large') past max_bytes (the read stops there). */
  download(file_id: string, max_bytes: number): Promise<Uint8Array>;
  /** The folder of this name at the top of the user's storage, created when missing. */
  ensureFolder(name: string): Promise<CloudFolder>;
  /** The folder's display name (an existing folder the user chose). */
  folder(folder_id: string): Promise<CloudFolder>;
  /** Add a new file; an existing file of the same name is never replaced. */
  upload(folder: CloudFolder, name: string, bytes: Uint8Array, content_type: string): Promise<CloudSaved>;
}

export type CloudProviderErrorKind = 'unauthorized' | 'not_found' | 'too_large' | 'forbidden' | 'failed';

/** A provider refused or failed. `kind` drives the server's refusal; the message is internal. */
export class CloudProviderError extends Error {
  constructor(
    readonly kind: CloudProviderErrorKind,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'CloudProviderError';
  }
}
