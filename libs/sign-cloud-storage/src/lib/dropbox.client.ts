import { bearer, bodyOf, call, json, offered, readLimited } from './http.js';
import { CloudProviderError, type CloudDriveClient, type CloudFolder, type CloudItem, type CloudListOptions, type CloudListPage, type FetchLike } from './types.js';

// Dropbox API v2 (https://www.dropbox.com/developers/documentation/http/documentation).
// Items are addressed by their stable "id:…" (accepted wherever a path is).

const RPC = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

interface DbxEntry {
  '.tag': 'file' | 'folder' | 'deleted';
  id?: string;
  name: string;
  size?: number;
  server_modified?: string;
  path_display?: string;
}

/** Dropbox-API-Arg must be ASCII: escape every non-ASCII character as \uXXXX. */
export function dropboxArg(v: unknown): string {
  return JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function itemOf(e: DbxEntry): CloudItem | null {
  if (e['.tag'] === 'deleted' || typeof e.id !== 'string') return null;
  const folder = e['.tag'] === 'folder';
  return { id: e.id, name: e.name, kind: folder ? 'folder' : 'file', mime_type: null, size: folder ? null : (e.size ?? null), modified_at: e.server_modified ?? null };
}

/** The cursor carries which listing it continues (folder listing or search). */
function cursorOf(kind: 'l' | 's', c: string | undefined, more: boolean): string | null {
  return more && typeof c === 'string' ? `${kind}:${c}` : null;
}

export class DropboxClient implements CloudDriveClient {
  readonly provider = 'dropbox' as const;

  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchLike,
  ) {}

  private rpc(path: string, body: unknown, okStatuses: readonly number[] = []): Promise<Response> {
    return call(this.fetchFn, `${RPC}${path}`, { method: 'POST', headers: bearer(this.token, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) }, okStatuses);
  }

  async account() {
    const b = await json<{ email?: string; name?: { display_name?: string } }>(await this.rpc('/users/get_current_account', null));
    return { label: b.email ?? b.name?.display_name ?? null };
  }

  async list(opts: CloudListOptions): Promise<CloudListPage> {
    const keep = (i: CloudItem) => (opts.folders_only ? i.kind === 'folder' : i.kind === 'folder' ? opts.query === null : offered(i.name, opts.extensions));
    if (opts.query !== null || opts.cursor?.startsWith('s:') === true) {
      const res =
        opts.cursor !== null
          ? await this.rpc('/files/search/continue_v2', { cursor: opts.cursor.slice(2) })
          : await this.rpc('/files/search_v2', { query: opts.query, options: { max_results: 100, file_status: 'active', filename_only: true } });
      const b = await json<{ matches?: { metadata?: { metadata?: DbxEntry } }[]; has_more?: boolean; cursor?: string }>(res);
      const items = (b.matches ?? []).map((m) => (m.metadata?.metadata === undefined ? null : itemOf(m.metadata.metadata))).filter((i): i is CloudItem => i !== null && keep(i));
      return { items, next_cursor: cursorOf('s', b.cursor, b.has_more === true) };
    }
    const res =
      opts.cursor !== null
        ? await this.rpc('/files/list_folder/continue', { cursor: opts.cursor.replace(/^l:/, '') })
        : await this.rpc('/files/list_folder', { path: opts.folder_id ?? '', limit: 200, include_deleted: false });
    const b = await json<{ entries?: DbxEntry[]; has_more?: boolean; cursor?: string }>(res);
    const items = (b.entries ?? [])
      .map(itemOf)
      .filter((i): i is CloudItem => i !== null && keep(i))
      .sort((a, b2) => (a.kind === b2.kind ? a.name.localeCompare(b2.name) : a.kind === 'folder' ? -1 : 1));
    return { items, next_cursor: cursorOf('l', b.cursor, b.has_more === true) };
  }

  private async entry(id: string): Promise<DbxEntry> {
    const res = await this.rpc('/files/get_metadata', { path: id }, [409]);
    if (res.status === 409) {
      await res.body?.cancel().catch(() => undefined);
      throw new CloudProviderError('not_found', 409, 'path not found');
    }
    return json<DbxEntry>(res);
  }

  async metadata(file_id: string) {
    const e = await this.entry(file_id);
    const i = itemOf(e);
    if (i === null) throw new CloudProviderError('not_found', null, 'deleted');
    return { id: i.id, name: i.name, kind: i.kind, size: i.size, mime_type: null };
  }

  async download(file_id: string, max_bytes: number) {
    const res = await call(this.fetchFn, `${CONTENT}/files/download`, { method: 'POST', headers: bearer(this.token, { 'Dropbox-API-Arg': dropboxArg({ path: file_id }) }) }, [409]);
    if (res.status === 409) {
      await res.body?.cancel().catch(() => undefined);
      throw new CloudProviderError('not_found', 409, 'path not found');
    }
    return readLimited(res, max_bytes);
  }

  async folder(folder_id: string): Promise<CloudFolder> {
    const e = await this.entry(folder_id);
    if (e['.tag'] !== 'folder' || typeof e.id !== 'string') throw new CloudProviderError('not_found', null, 'not a folder');
    return { id: e.id, name: e.name };
  }

  async ensureFolder(name: string): Promise<CloudFolder> {
    const path = `/${name}`;
    const res = await this.rpc('/files/create_folder_v2', { path, autorename: false }, [409]);
    if (res.status !== 409) {
      const b = await json<{ metadata?: DbxEntry }>(res);
      if (b.metadata?.id !== undefined) return { id: b.metadata.id, name: b.metadata.name };
    } else {
      await res.body?.cancel().catch(() => undefined);
    }
    // Already there (path/conflict): use it when it is a folder.
    return this.folder(path);
  }

  async upload(folder: CloudFolder, name: string, bytes: Uint8Array) {
    const e = await this.entry(folder.id);
    if (e['.tag'] !== 'folder' || typeof e.path_display !== 'string') throw new CloudProviderError('not_found', null, 'not a folder');
    const res = await call(this.fetchFn, `${CONTENT}/files/upload`, {
      method: 'POST',
      headers: bearer(this.token, {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': dropboxArg({ path: `${e.path_display}/${name}`, mode: 'add', autorename: true, mute: true }),
      }),
      body: bodyOf(bytes),
    });
    const b = await json<DbxEntry>(res);
    if (typeof b.id !== 'string') throw new CloudProviderError('failed', null, 'upload did not finish');
    return { id: b.id, name: b.name, web_url: null };
  }
}
