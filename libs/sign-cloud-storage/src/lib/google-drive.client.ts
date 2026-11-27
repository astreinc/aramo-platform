import { bearer, bodyOf, call, concatBytes, json, offered, readLimited } from './http.js';
import { CloudProviderError, type CloudDriveClient, type CloudFolder, type CloudItem, type CloudListOptions, type CloudListPage, type FetchLike } from './types.js';

// Google Drive API v3 (https://developers.google.com/drive/api/reference/rest/v3).

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MIME_OF_EXT: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
};
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime';

interface GFile {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

/** A Drive query string literal ('…' with \ and ' escaped). */
export function driveLiteral(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function itemOf(f: GFile): CloudItem {
  const folder = f.mimeType === FOLDER_MIME;
  const size = f.size === undefined ? null : Number(f.size);
  return { id: f.id, name: f.name, kind: folder ? 'folder' : 'file', mime_type: folder ? null : (f.mimeType ?? null), size: Number.isFinite(size) ? size : null, modified_at: f.modifiedTime ?? null };
}

export class GoogleDriveClient implements CloudDriveClient {
  readonly provider = 'google_drive' as const;

  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchLike,
  ) {}

  async account() {
    const res = await call(this.fetchFn, `${API}/about?fields=${encodeURIComponent('user(emailAddress,displayName)')}`, { headers: bearer(this.token) });
    const b = await json<{ user?: { emailAddress?: string; displayName?: string } }>(res);
    return { label: b.user?.emailAddress ?? b.user?.displayName ?? null };
  }

  async list(opts: CloudListOptions): Promise<CloudListPage> {
    const mimes = opts.extensions.map((e) => MIME_OF_EXT[e]).filter((m): m is string => m !== undefined);
    const fileClause = mimes.map((m) => `mimeType = ${driveLiteral(m)}`).join(' or ');
    const folderClause = `mimeType = ${driveLiteral(FOLDER_MIME)}`;
    const clauses = ['trashed = false'];
    if (opts.query !== null) {
      clauses.push(`name contains ${driveLiteral(opts.query)}`);
      clauses.push(opts.folders_only ? folderClause : `(${fileClause || 'false'})`);
    } else {
      clauses.push(`${driveLiteral(opts.folder_id ?? 'root')} in parents`);
      clauses.push(opts.folders_only || fileClause === '' ? folderClause : `(${folderClause} or ${fileClause})`);
    }
    const u = new URL(`${API}/files`);
    u.searchParams.set('q', clauses.join(' and '));
    u.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`);
    u.searchParams.set('pageSize', '100');
    u.searchParams.set('spaces', 'drive');
    if (opts.query === null) u.searchParams.set('orderBy', 'folder,name');
    if (opts.cursor !== null) u.searchParams.set('pageToken', opts.cursor);
    const b = await json<{ files?: GFile[]; nextPageToken?: string }>(await call(this.fetchFn, u.toString(), { headers: bearer(this.token) }));
    const items = (b.files ?? []).map(itemOf).filter((i) => i.kind === 'folder' || offered(i.name, opts.extensions) || i.mime_type === 'application/pdf');
    return { items, next_cursor: b.nextPageToken ?? null };
  }

  async metadata(file_id: string) {
    const res = await call(this.fetchFn, `${API}/files/${encodeURIComponent(file_id)}?fields=${encodeURIComponent('id,name,mimeType,size')}`, { headers: bearer(this.token) });
    const i = itemOf(await json<GFile>(res));
    return { id: i.id, name: i.name, kind: i.kind, size: i.size, mime_type: i.mime_type };
  }

  async download(file_id: string, max_bytes: number) {
    const res = await call(this.fetchFn, `${API}/files/${encodeURIComponent(file_id)}?alt=media`, { headers: bearer(this.token) });
    return readLimited(res, max_bytes);
  }

  async folder(folder_id: string): Promise<CloudFolder> {
    const m = await this.metadata(folder_id);
    if (m.kind !== 'folder') throw new CloudProviderError('not_found', null, 'not a folder');
    return { id: m.id, name: m.name };
  }

  async ensureFolder(name: string): Promise<CloudFolder> {
    // drive.file sees only folders this app created: a user's own folder of the same name is
    // never written to.
    const u = new URL(`${API}/files`);
    u.searchParams.set('q', `name = ${driveLiteral(name)} and mimeType = ${driveLiteral(FOLDER_MIME)} and 'root' in parents and trashed = false`);
    u.searchParams.set('fields', 'files(id,name)');
    u.searchParams.set('spaces', 'drive');
    const found = await json<{ files?: GFile[] }>(await call(this.fetchFn, u.toString(), { headers: bearer(this.token) }));
    const hit = found.files?.[0];
    if (hit !== undefined) return { id: hit.id, name: hit.name };
    const res = await call(this.fetchFn, `${API}/files?fields=id,name`, {
      method: 'POST',
      headers: bearer(this.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: ['root'] }),
    });
    const f = await json<GFile>(res);
    return { id: f.id, name: f.name };
  }

  async upload(folder: CloudFolder, name: string, bytes: Uint8Array, content_type: string) {
    const boundary = `aramo-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const enc = new TextEncoder();
    const head = enc.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folder.id] })}\r\n` +
        `--${boundary}\r\nContent-Type: ${content_type}\r\n\r\n`,
    );
    const tail = enc.encode(`\r\n--${boundary}--`);
    const res = await call(this.fetchFn, `${UPLOAD}?uploadType=multipart&fields=id,name,webViewLink`, {
      method: 'POST',
      headers: bearer(this.token, { 'Content-Type': `multipart/related; boundary=${boundary}` }),
      body: bodyOf(concatBytes([head, bytes, tail])),
    });
    const f = await json<GFile>(res);
    return { id: f.id, name: f.name, web_url: f.webViewLink ?? null };
  }
}
