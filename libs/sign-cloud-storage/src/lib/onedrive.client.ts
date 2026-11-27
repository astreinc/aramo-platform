import { bearer, bodyOf, call, json, offered, readLimited } from './http.js';
import { CloudProviderError, type CloudDriveClient, type CloudFolder, type CloudItem, type CloudListOptions, type CloudListPage, type FetchLike } from './types.js';

// Microsoft Graph v1.0, the signed-in user's OneDrive (personal, or OneDrive for work or
// school): https://learn.microsoft.com/graph/api/resources/onedrive

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SELECT = 'id,name,size,file,folder,lastModifiedDateTime';
// Upload-session chunks must be multiples of 320 KiB; 10 MiB = 32 × 320 KiB.
const CHUNK = 320 * 1024 * 32;

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  file?: { mimeType?: string };
  folder?: unknown;
  lastModifiedDateTime?: string;
  webUrl?: string;
}

function itemOf(d: DriveItem): CloudItem {
  const folder = d.folder !== undefined && d.folder !== null;
  return {
    id: d.id,
    name: d.name,
    kind: folder ? 'folder' : 'file',
    mime_type: folder ? null : (d.file?.mimeType ?? null),
    size: typeof d.size === 'number' ? d.size : null,
    modified_at: d.lastModifiedDateTime ?? null,
  };
}

/** The next-page cursor is Graph's own nextLink, accepted back only on the Graph host. */
function nextLinkOf(cursor: string): string {
  let url: string;
  try {
    url = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new CloudProviderError('failed', null, 'bad cursor');
  }
  if (!url.startsWith(`${GRAPH}/`)) throw new CloudProviderError('failed', null, 'bad cursor');
  return url;
}

export class OneDriveClient implements CloudDriveClient {
  readonly provider = 'onedrive' as const;

  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchLike,
  ) {}

  async account() {
    const b = await json<{ mail?: string | null; userPrincipalName?: string; displayName?: string }>(
      await call(this.fetchFn, `${GRAPH}/me?$select=displayName,mail,userPrincipalName`, { headers: bearer(this.token) }),
    );
    return { label: b.mail ?? b.userPrincipalName ?? b.displayName ?? null };
  }

  async list(opts: CloudListOptions): Promise<CloudListPage> {
    let url: string;
    if (opts.cursor !== null) url = nextLinkOf(opts.cursor);
    else if (opts.query !== null) url = `${GRAPH}/me/drive/root/search(q='${encodeURIComponent(opts.query.replace(/'/g, "''"))}')?$select=${SELECT}&$top=100`;
    else url = `${GRAPH}/me/drive/${opts.folder_id === null ? 'root' : `items/${encodeURIComponent(opts.folder_id)}`}/children?$select=${SELECT}&$top=100&$orderby=name`;
    const b = await json<{ value?: DriveItem[]; '@odata.nextLink'?: string }>(await call(this.fetchFn, url, { headers: bearer(this.token) }));
    const items = (b.value ?? [])
      .map(itemOf)
      .filter((i) => (opts.folders_only ? i.kind === 'folder' : opts.query !== null ? i.kind === 'file' && offered(i.name, opts.extensions) : i.kind === 'folder' || offered(i.name, opts.extensions)));
    const next = b['@odata.nextLink'];
    return { items, next_cursor: typeof next === 'string' ? Buffer.from(next, 'utf8').toString('base64url') : null };
  }

  async metadata(file_id: string) {
    const d = await json<DriveItem>(await call(this.fetchFn, `${GRAPH}/me/drive/items/${encodeURIComponent(file_id)}?$select=${SELECT}`, { headers: bearer(this.token) }));
    const i = itemOf(d);
    return { id: i.id, name: i.name, kind: i.kind, size: i.size, mime_type: i.mime_type };
  }

  async download(file_id: string, max_bytes: number) {
    // 302 to a short-lived pre-authenticated URL; fetch follows it and drops the
    // Authorization header on the cross-origin hop.
    const res = await call(this.fetchFn, `${GRAPH}/me/drive/items/${encodeURIComponent(file_id)}/content`, { headers: bearer(this.token) });
    return readLimited(res, max_bytes);
  }

  async folder(folder_id: string): Promise<CloudFolder> {
    const m = await this.metadata(folder_id);
    if (m.kind !== 'folder') throw new CloudProviderError('not_found', null, 'not a folder');
    return { id: m.id, name: m.name };
  }

  async ensureFolder(name: string): Promise<CloudFolder> {
    const path = `${GRAPH}/me/drive/root:/${encodeURIComponent(name)}?$select=id,name,folder`;
    const got = await call(this.fetchFn, path, { headers: bearer(this.token) }, [404]);
    if (got.status !== 404) {
      const d = await json<DriveItem>(got);
      if (d.folder !== undefined) return { id: d.id, name: d.name };
      throw new CloudProviderError('forbidden', null, 'a file has the folder name');
    }
    await got.body?.cancel().catch(() => undefined);
    const res = await call(
      this.fetchFn,
      `${GRAPH}/me/drive/root/children`,
      { method: 'POST', headers: bearer(this.token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }) },
      [409],
    );
    if (res.status === 409) {
      // Created in the meantime: read it again.
      await res.body?.cancel().catch(() => undefined);
      const d = await json<DriveItem>(await call(this.fetchFn, path, { headers: bearer(this.token) }));
      return { id: d.id, name: d.name };
    }
    const d = await json<DriveItem>(res);
    return { id: d.id, name: d.name };
  }

  async upload(folder: CloudFolder, name: string, bytes: Uint8Array) {
    const session = await json<{ uploadUrl?: string }>(
      await call(this.fetchFn, `${GRAPH}/me/drive/items/${encodeURIComponent(folder.id)}:/${encodeURIComponent(name)}:/createUploadSession`, {
        method: 'POST',
        headers: bearer(this.token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }),
      }),
    );
    if (typeof session.uploadUrl !== 'string' || !session.uploadUrl.startsWith('https://')) throw new CloudProviderError('failed', null, 'no upload session');
    let last: Response | null = null;
    const total = bytes.byteLength;
    for (let start = 0; start < total || (total === 0 && start === 0); start += CHUNK) {
      const end = Math.min(start + CHUNK, total);
      // The upload URL is pre-authenticated: no Authorization header (Graph refuses one).
      last = await call(this.fetchFn, session.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${start}-${Math.max(end - 1, 0)}/${total}` },
        body: bodyOf(bytes.subarray(start, end)),
      });
      if (total === 0) break;
    }
    const d = last === null ? null : await json<DriveItem>(last);
    if (d === null || typeof d.id !== 'string') throw new CloudProviderError('failed', null, 'upload did not finish');
    return { id: d.id, name: d.name, web_url: d.webUrl ?? null };
  }
}
