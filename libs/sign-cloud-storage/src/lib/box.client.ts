import { bearer, call, json, offered, readLimited } from './http.js';
import { CloudProviderError, type CloudDriveClient, type CloudFolder, type CloudItem, type CloudListOptions, type CloudListPage, type FetchLike } from './types.js';

// Box Content API 2.0 (https://developer.box.com/reference/). Folder "0" is the user's
// All Files root.

const API = 'https://api.box.com/2.0';
const UPLOAD = 'https://upload.box.com/api/2.0/files/content';
const FIELDS = 'id,type,name,size,modified_at';

interface BoxItem {
  type: 'file' | 'folder' | 'web_link';
  id: string;
  name: string;
  size?: number;
  modified_at?: string;
}

function itemOf(b: BoxItem): CloudItem | null {
  if (b.type !== 'file' && b.type !== 'folder') return null;
  return { id: b.id, name: b.name, kind: b.type, mime_type: null, size: b.type === 'file' ? (b.size ?? null) : null, modified_at: b.modified_at ?? null };
}

/** "name.pdf" → "name (2).pdf". */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? `${name} (${n})` : `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}

export class BoxClient implements CloudDriveClient {
  readonly provider = 'box' as const;

  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchLike,
  ) {}

  async account() {
    const b = await json<{ login?: string; name?: string }>(await call(this.fetchFn, `${API}/users/me?fields=login,name`, { headers: bearer(this.token) }));
    return { label: b.login ?? b.name ?? null };
  }

  async list(opts: CloudListOptions): Promise<CloudListPage> {
    if (opts.query !== null) {
      const offset = opts.cursor === null ? 0 : Number(opts.cursor);
      const u = new URL(`${API}/search`);
      u.searchParams.set('query', opts.query);
      u.searchParams.set('type', opts.folders_only ? 'folder' : 'file');
      if (!opts.folders_only && opts.extensions.length > 0) u.searchParams.set('file_extensions', opts.extensions.join(','));
      u.searchParams.set('content_types', 'name');
      u.searchParams.set('fields', FIELDS);
      u.searchParams.set('limit', '100');
      u.searchParams.set('offset', String(Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0));
      const b = await json<{ entries?: BoxItem[]; total_count?: number; offset?: number; limit?: number }>(await call(this.fetchFn, u.toString(), { headers: bearer(this.token) }));
      const items = (b.entries ?? []).map(itemOf).filter((i): i is CloudItem => i !== null && (opts.folders_only || offered(i.name, opts.extensions)));
      const next = (b.offset ?? 0) + (b.limit ?? 100);
      return { items, next_cursor: typeof b.total_count === 'number' && next < b.total_count ? String(next) : null };
    }
    const u = new URL(`${API}/folders/${encodeURIComponent(opts.folder_id ?? '0')}/items`);
    u.searchParams.set('fields', FIELDS);
    u.searchParams.set('limit', '200');
    u.searchParams.set('usemarker', 'true');
    u.searchParams.set('sort', 'name');
    if (opts.cursor !== null) u.searchParams.set('marker', opts.cursor);
    const b = await json<{ entries?: BoxItem[]; next_marker?: string | null }>(await call(this.fetchFn, u.toString(), { headers: bearer(this.token) }));
    const items = (b.entries ?? [])
      .map(itemOf)
      .filter((i): i is CloudItem => i !== null && (i.kind === 'folder' || (!opts.folders_only && offered(i.name, opts.extensions))));
    return { items, next_cursor: typeof b.next_marker === 'string' && b.next_marker.length > 0 ? b.next_marker : null };
  }

  async metadata(file_id: string) {
    const b = await json<BoxItem>(await call(this.fetchFn, `${API}/files/${encodeURIComponent(file_id)}?fields=id,type,name,size`, { headers: bearer(this.token) }));
    const i = itemOf(b);
    if (i === null) throw new CloudProviderError('not_found', null, 'not a file');
    return { id: i.id, name: i.name, kind: i.kind, size: i.size, mime_type: null };
  }

  async download(file_id: string, max_bytes: number) {
    // 302 to a pre-authorized download URL (fetch follows; the Authorization header is
    // dropped on the cross-origin hop).
    const res = await call(this.fetchFn, `${API}/files/${encodeURIComponent(file_id)}/content`, { headers: bearer(this.token) });
    return readLimited(res, max_bytes);
  }

  async folder(folder_id: string): Promise<CloudFolder> {
    const b = await json<BoxItem>(await call(this.fetchFn, `${API}/folders/${encodeURIComponent(folder_id)}?fields=id,type,name`, { headers: bearer(this.token) }));
    if (b.type !== 'folder') throw new CloudProviderError('not_found', null, 'not a folder');
    return { id: b.id, name: b.name };
  }

  async ensureFolder(name: string): Promise<CloudFolder> {
    const res = await call(
      this.fetchFn,
      `${API}/folders?fields=id,name`,
      { method: 'POST', headers: bearer(this.token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ name, parent: { id: '0' } }) },
      [409],
    );
    if (res.status !== 409) {
      const b = await json<BoxItem>(res);
      return { id: b.id, name: b.name };
    }
    // item_name_in_use: the conflicting item is named in context_info.
    const b = await json<{ context_info?: { conflicts?: BoxItem[] | BoxItem } }>(res);
    const c = b.context_info?.conflicts;
    const hit = Array.isArray(c) ? c[0] : c;
    if (hit === undefined || hit.type !== 'folder') throw new CloudProviderError('forbidden', 409, 'a file has the folder name');
    return { id: hit.id, name: hit.name };
  }

  async upload(folder: CloudFolder, name: string, bytes: Uint8Array, content_type: string) {
    // Box refuses a duplicate name (409): never replace, number the copy instead.
    for (let n = 1; n <= 20; n += 1) {
      const attempt = n === 1 ? name : numberedName(name, n);
      const form = new FormData();
      form.append('attributes', JSON.stringify({ name: attempt, parent: { id: folder.id } }));
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      form.append('file', new Blob([copy.buffer], { type: content_type }), attempt);
      const res = await call(this.fetchFn, `${UPLOAD}?fields=id,name`, { method: 'POST', headers: bearer(this.token), body: form }, [409]);
      if (res.status === 409) {
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      const b = await json<{ entries?: BoxItem[] }>(res);
      const f = b.entries?.[0];
      if (f === undefined) throw new CloudProviderError('failed', null, 'upload did not finish');
      return { id: f.id, name: f.name, web_url: `https://app.box.com/file/${encodeURIComponent(f.id)}` };
    }
    throw new CloudProviderError('failed', 409, 'no free file name');
  }
}
