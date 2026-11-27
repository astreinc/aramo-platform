import { BoxClient, CloudProviderError, DropboxClient, GoogleDriveClient, OneDriveClient, cloudDriveClient, driveLiteral, dropboxArg, numberedName } from '../index.js';

import { PDF, bytesRes, fakeFetch, jsonRes, textOf } from './fake-fetch.js';

const LIST = { folder_id: null, query: null, cursor: null, folders_only: false, extensions: ['pdf'] } as const;

describe('cloudDriveClient', () => {
  it('builds the client of each provider', () => {
    const f = fakeFetch([]);
    expect(cloudDriveClient('google_drive', 't', f)).toBeInstanceOf(GoogleDriveClient);
    expect(cloudDriveClient('onedrive', 't', f)).toBeInstanceOf(OneDriveClient);
    expect(cloudDriveClient('dropbox', 't', f)).toBeInstanceOf(DropboxClient);
    expect(cloudDriveClient('box', 't', f)).toBeInstanceOf(BoxClient);
  });
});

describe('GoogleDriveClient', () => {
  it('lists folders and PDFs of a folder with the bearer token', async () => {
    const f = fakeFetch([
      jsonRes({
        files: [
          { id: 'f1', name: 'Contracts', mimeType: 'application/vnd.google-apps.folder' },
          { id: 'p1', name: 'Offer.pdf', mimeType: 'application/pdf', size: '1234', modifiedTime: '2026-11-01T00:00:00Z' },
        ],
        nextPageToken: 'n2',
      }),
    ]);
    const page = await new GoogleDriveClient('tok', f).list(LIST);
    expect(page.items).toEqual([
      { id: 'f1', name: 'Contracts', kind: 'folder', mime_type: null, size: null, modified_at: null },
      { id: 'p1', name: 'Offer.pdf', kind: 'file', mime_type: 'application/pdf', size: 1234, modified_at: '2026-11-01T00:00:00Z' },
    ]);
    expect(page.next_cursor).toBe('n2');
    const u = new URL(f.calls[0]?.url ?? '');
    expect(u.searchParams.get('q')).toContain("'root' in parents");
    expect(u.searchParams.get('q')).toContain("mimeType = 'application/pdf'");
    expect(f.calls[0]?.headers['authorization']).toBe('Bearer tok');
  });

  it('escapes the search text in the Drive query', async () => {
    expect(driveLiteral("it's \\")).toBe("'it\\'s \\\\'");
    const f = fakeFetch([jsonRes({ files: [] })]);
    await new GoogleDriveClient('t', f).list({ ...LIST, query: "o'neil" });
    expect(new URL(f.calls[0]?.url ?? '').searchParams.get('q')).toContain("name contains 'o\\'neil'");
  });

  it('downloads with a size cap', async () => {
    const f = fakeFetch([bytesRes(PDF), bytesRes(new Uint8Array(100))]);
    const c = new GoogleDriveClient('t', f);
    expect(await c.download('p1', 1000)).toEqual(PDF);
    expect(f.calls[0]?.url).toContain('/files/p1?alt=media');
    await expect(c.download('p2', 10)).rejects.toMatchObject({ kind: 'too_large' });
  });

  it('finds or creates the app folder, then uploads multipart into it', async () => {
    const f = fakeFetch([jsonRes({ files: [] }), jsonRes({ id: 'fold', name: 'Aramo Sign' }), jsonRes({ id: 'new', name: 'A (signed).pdf', webViewLink: 'https://drive/x' })]);
    const c = new GoogleDriveClient('t', f);
    const folder = await c.ensureFolder('Aramo Sign');
    expect(folder).toEqual({ id: 'fold', name: 'Aramo Sign' });
    expect(JSON.parse(String(f.calls[1]?.body))).toEqual({ name: 'Aramo Sign', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] });
    const saved = await c.upload(folder, 'A (signed).pdf', PDF, 'application/pdf');
    expect(saved).toEqual({ id: 'new', name: 'A (signed).pdf', web_url: 'https://drive/x' });
    const body = textOf(f.calls[2]?.body);
    expect(body).toContain('"parents":["fold"]');
    expect(body).toContain('%PDF-1.7');
    expect(f.calls[2]?.headers['content-type']).toMatch(/^multipart\/related; boundary=/);
  });

  it('maps 401 to unauthorized and 404 to not_found', async () => {
    const f = fakeFetch([new Response('', { status: 401 }), new Response('', { status: 404 })]);
    const c = new GoogleDriveClient('t', f);
    await expect(c.account()).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
    await expect(c.metadata('x')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('reads the account email', async () => {
    const f = fakeFetch([jsonRes({ user: { emailAddress: 'a@example.com', displayName: 'A' } })]);
    expect(await new GoogleDriveClient('t', f).account()).toEqual({ label: 'a@example.com' });
  });
});

describe('OneDriveClient', () => {
  it('lists children, keeps folders and offered files, and wraps the next link as an opaque cursor', async () => {
    const next = 'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=abc';
    const f = fakeFetch([
      jsonRes({
        value: [
          { id: 'd', name: 'Docs', folder: { childCount: 1 } },
          { id: 'p', name: 'a.PDF', size: 10, file: { mimeType: 'application/pdf' } },
          { id: 'x', name: 'b.xlsx', size: 10, file: {} },
        ],
        '@odata.nextLink': next,
      }),
      jsonRes({ value: [] }),
    ]);
    const c = new OneDriveClient('t', f);
    const page = await c.list(LIST);
    expect(page.items.map((i) => i.id)).toEqual(['d', 'p']);
    expect(page.next_cursor).not.toBeNull();
    await c.list({ ...LIST, cursor: page.next_cursor });
    expect(f.calls[1]?.url).toBe(next);
  });

  it('refuses a cursor that points off the Graph host', async () => {
    const c = new OneDriveClient('t', fakeFetch([]));
    const evil = Buffer.from('https://evil.example/steal', 'utf8').toString('base64url');
    await expect(c.list({ ...LIST, cursor: evil })).rejects.toBeInstanceOf(CloudProviderError);
  });

  it('creates the folder when missing and uploads through an upload session without the bearer token', async () => {
    const f = fakeFetch([
      new Response('', { status: 404 }),
      jsonRes({ id: 'fid', name: 'Aramo Sign', folder: {} }, 201),
      jsonRes({ uploadUrl: 'https://upload.example/session' }),
      jsonRes({ id: 'item', name: 'A (signed) 1.pdf', webUrl: 'https://onedrive/x' }, 201),
    ]);
    const c = new OneDriveClient('t', f);
    const folder = await c.ensureFolder('Aramo Sign');
    expect(folder.id).toBe('fid');
    const saved = await c.upload(folder, 'A (signed).pdf', PDF);
    expect(saved).toEqual({ id: 'item', name: 'A (signed) 1.pdf', web_url: 'https://onedrive/x' });
    expect(f.calls[2]?.url).toContain('/me/drive/items/fid:/A%20(signed).pdf:/createUploadSession');
    expect(JSON.parse(String(f.calls[2]?.body))).toEqual({ item: { '@microsoft.graph.conflictBehavior': 'rename' } });
    expect(f.calls[3]?.headers['authorization']).toBeUndefined();
    expect(f.calls[3]?.headers['content-range']).toBe(`bytes 0-${PDF.byteLength - 1}/${PDF.byteLength}`);
  });

  it('uses an existing folder of that name', async () => {
    const f = fakeFetch([jsonRes({ id: 'have', name: 'Aramo Sign', folder: {} })]);
    expect(await new OneDriveClient('t', f).ensureFolder('Aramo Sign')).toEqual({ id: 'have', name: 'Aramo Sign' });
  });

  it('search returns files only', async () => {
    const f = fakeFetch([jsonRes({ value: [{ id: 'd', name: 'x.pdf folder', folder: {} }, { id: 'p', name: 'x.pdf', file: {} }] })]);
    const page = await new OneDriveClient('t', f).list({ ...LIST, query: "o'x" });
    expect(page.items.map((i) => i.id)).toEqual(['p']);
    expect(f.calls[0]?.url).toContain("search(q='o''x')");
  });
});

describe('DropboxClient', () => {
  it('lists a folder (folders first), keeping offered files', async () => {
    const f = fakeFetch([
      jsonRes({
        entries: [
          { '.tag': 'file', id: 'id:2', name: 'z.pdf', size: 5 },
          { '.tag': 'folder', id: 'id:1', name: 'Work' },
          { '.tag': 'file', id: 'id:3', name: 'note.txt', size: 1 },
        ],
        has_more: true,
        cursor: 'CUR',
      }),
      jsonRes({ entries: [], has_more: false }),
    ]);
    const c = new DropboxClient('t', f);
    const page = await c.list(LIST);
    expect(page.items.map((i) => i.id)).toEqual(['id:1', 'id:2']);
    expect(page.next_cursor).toBe('l:CUR');
    expect(JSON.parse(String(f.calls[0]?.body))).toEqual({ path: '', limit: 200, include_deleted: false });
    await c.list({ ...LIST, cursor: 'l:CUR' });
    expect(f.calls[1]?.url).toBe('https://api.dropboxapi.com/2/files/list_folder/continue');
  });

  it('escapes non-ASCII in Dropbox-API-Arg and downloads by id', async () => {
    expect(dropboxArg({ path: '/Résumé.pdf' })).toBe('{"path":"/R\\u00e9sum\\u00e9.pdf"}');
    const f = fakeFetch([bytesRes(PDF)]);
    expect(await new DropboxClient('t', f).download('id:9', 1000)).toEqual(PDF);
    expect(f.calls[0]?.headers['dropbox-api-arg']).toBe('{"path":"id:9"}');
  });

  it('a 409 on metadata is not_found', async () => {
    const f = fakeFetch([jsonRes({ error_summary: 'path/not_found/' }, 409)]);
    await expect(new DropboxClient('t', f).metadata('id:x')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('reuses an existing folder on conflict and uploads with autorename (never overwrite)', async () => {
    const f = fakeFetch([
      jsonRes({ error_summary: 'path/conflict/folder' }, 409),
      jsonRes({ '.tag': 'folder', id: 'id:f', name: 'Aramo Sign', path_display: '/Aramo Sign' }),
      jsonRes({ '.tag': 'folder', id: 'id:f', name: 'Aramo Sign', path_display: '/Aramo Sign' }),
      jsonRes({ '.tag': 'file', id: 'id:new', name: 'A (signed).pdf' }),
    ]);
    const c = new DropboxClient('t', f);
    const folder = await c.ensureFolder('Aramo Sign');
    expect(folder).toEqual({ id: 'id:f', name: 'Aramo Sign' });
    const saved = await c.upload(folder, 'A (signed).pdf', PDF);
    expect(saved.id).toBe('id:new');
    expect(JSON.parse(f.calls[3]?.headers['dropbox-api-arg'] ?? '{}')).toEqual({ path: '/Aramo Sign/A (signed).pdf', mode: 'add', autorename: true, mute: true });
  });

  it('search continues with its own cursor', async () => {
    const f = fakeFetch([
      jsonRes({ matches: [{ metadata: { metadata: { '.tag': 'file', id: 'id:a', name: 'a.pdf' } } }], has_more: true, cursor: 'S1' }),
      jsonRes({ matches: [], has_more: false }),
    ]);
    const c = new DropboxClient('t', f);
    const p = await c.list({ ...LIST, query: 'a' });
    expect(p.next_cursor).toBe('s:S1');
    await c.list({ ...LIST, cursor: 's:S1' });
    expect(JSON.parse(String(f.calls[1]?.body))).toEqual({ cursor: 'S1' });
  });
});

describe('BoxClient', () => {
  it('lists the root folder with a marker cursor', async () => {
    const f = fakeFetch([jsonRes({ entries: [{ type: 'folder', id: '5', name: 'HR' }, { type: 'file', id: '6', name: 'a.pdf', size: 3 }, { type: 'web_link', id: '7', name: 'l' }], next_marker: 'M' })]);
    const p = await new BoxClient('t', f).list(LIST);
    expect(p.items.map((i) => i.id)).toEqual(['5', '6']);
    expect(p.next_cursor).toBe('M');
    expect(f.calls[0]?.url).toContain('/folders/0/items');
  });

  it('searches files by extension with an offset cursor', async () => {
    const f = fakeFetch([jsonRes({ entries: [{ type: 'file', id: '6', name: 'a.pdf' }], total_count: 150, offset: 0, limit: 100 })]);
    const p = await new BoxClient('t', f).list({ ...LIST, query: 'a' });
    expect(p.next_cursor).toBe('100');
    const u = new URL(f.calls[0]?.url ?? '');
    expect(u.searchParams.get('file_extensions')).toBe('pdf');
    expect(u.searchParams.get('type')).toBe('file');
  });

  it('uses the conflicting folder on 409, and numbers a duplicate file name', async () => {
    expect(numberedName('A (signed).pdf', 2)).toBe('A (signed) (2).pdf');
    const f = fakeFetch([
      jsonRes({ code: 'item_name_in_use', context_info: { conflicts: [{ type: 'folder', id: '42', name: 'Aramo Sign' }] } }, 409),
      jsonRes({ code: 'item_name_in_use' }, 409),
      jsonRes({ entries: [{ type: 'file', id: '99', name: 'A (signed) (2).pdf' }] }, 201),
    ]);
    const c = new BoxClient('t', f);
    const folder = await c.ensureFolder('Aramo Sign');
    expect(folder.id).toBe('42');
    const saved = await c.upload(folder, 'A (signed).pdf', PDF, 'application/pdf');
    expect(saved).toEqual({ id: '99', name: 'A (signed) (2).pdf', web_url: 'https://app.box.com/file/99' });
    expect(f.calls[2]?.body).toBeInstanceOf(FormData);
    expect(JSON.parse(String((f.calls[2]?.body as FormData).get('attributes')))).toEqual({ name: 'A (signed) (2).pdf', parent: { id: '42' } });
  });

  it('a network failure is a provider failure', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as Parameters<typeof cloudDriveClient>[2];
    await expect(new BoxClient('t', f).account()).rejects.toMatchObject({ kind: 'failed', status: null });
  });
});
