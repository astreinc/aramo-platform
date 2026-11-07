import 'reflect-metadata';
import { crc32 } from 'node:zlib';

import { type AuthContextType } from '@aramo/auth';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { SenderContextService } from '../app/sender/sender-context.service.js';
import { SenderEnvelopeService } from '../app/sender/sender-envelope.service.js';
import {
  LibreOfficeWordConverterAdapter,
  isEncryptedOfficePackage,
  wordConverterFromEnv,
} from '../app/word-conversion/libreoffice-word-converter.adapter.js';
import { WORD_MAX_BYTES, WordConversionError, type WordConversionPort } from '../app/word-conversion/word-conversion.port.js';

// Aramo-Sign-Mobile-Amendment-M-A13 (LOCKED) R-4 / #8 — Word uploads are converted to PDF by a
// LibreOffice-based converter service (Gotenberg-style API), dark by default. The adapter is
// tested against a stub; one real-container test runs only with SIGN_WORD_CONVERTER_TEST_URL.

const TENANT = 'a1000000-0000-7000-8000-000000000001';
const USER = 'a1000000-0000-7000-8000-000000000002';
const ENV = 'e5000000-0000-7000-8000-0000000000a1';
const AUTH = { sub: USER, tenant_id: TENANT, scopes: ['sign:envelope:create', 'sign:envelope:read', 'sign:envelope:send'], consumer_type: 'sign' } as unknown as AuthContextType;

// A minimal, valid .docx built as a STORED zip (no compression), so the test needs no zip library.
export function minimalDocx(text = 'Hello from M-A13'): Uint8Array {
  const files: Array<[string, string]> = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`],
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const n = Buffer.from(name, 'utf8');
    const d = Buffer.from(content, 'utf8');
    const crc = crc32(d);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(d.length, 18); local.writeUInt32LE(d.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(d.length, 20); central.writeUInt32LE(d.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, d);
    centrals.push(central, n);
    offset += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

async function onePagePdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage([612, 792]);
  return d.save();
}

const encryptedOoxml = (): Uint8Array =>
  new Uint8Array(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64), Buffer.from('EncryptedPackage', 'utf16le')]));

describe('M-A13 R-4 — LibreOffice converter adapter (stub)', () => {
  it('POSTs the file as multipart `files` to /forms/libreoffice/convert and returns the PDF', async () => {
    const pdf = await onePagePdf();
    const fetchStub = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(Buffer.from(pdf), { status: 200, headers: { 'content-type': 'application/pdf' } }));
    const out = await new LibreOfficeWordConverterAdapter('http://converter:3000/', fetchStub as unknown as typeof fetch).convert({ bytes: minimalDocx(), filename: 'Offer letter.docx' });
    expect(Buffer.from(out).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const [url, init] = fetchStub.mock.calls[0] ?? [];
    expect(url).toBe('http://converter:3000/forms/libreoffice/convert');
    expect(init?.method).toBe('POST');
    const form = init?.body as FormData;
    const file = form.get('files') as File;
    expect(file.name).toBe('Offer letter.docx');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses over 20 MB before calling the converter', async () => {
    const fetchStub = vi.fn();
    await expect(new LibreOfficeWordConverterAdapter('http://c', fetchStub as never).convert({ bytes: new Uint8Array(WORD_MAX_BYTES + 1), filename: 'big.docx' })).rejects.toMatchObject({ reason: 'word_too_large' });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('an encrypted OOXML package is password-protected (detected locally)', async () => {
    expect(isEncryptedOfficePackage(encryptedOoxml())).toBe(true);
    expect(isEncryptedOfficePackage(minimalDocx())).toBe(false);
    const fetchStub = vi.fn();
    await expect(new LibreOfficeWordConverterAdapter('http://c', fetchStub as never).convert({ bytes: encryptedOoxml(), filename: 'locked.docx' })).rejects.toMatchObject({ reason: 'word_password_protected' });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('maps converter refusals: a password message, 413, other errors, a non-PDF body, transport errors and the timeout', async () => {
    const run = (res: Response | Error, timeoutMs = 60_000) =>
      new LibreOfficeWordConverterAdapter('http://c', (async () => { if (res instanceof Error) throw res; return res; }) as unknown as typeof fetch, timeoutMs)
        .convert({ bytes: minimalDocx(), filename: 'a.doc' })
        .catch((e: unknown) => (e as WordConversionError).reason);
    expect(await run(new Response('LibreOffice failed to process a document: a password may be required', { status: 400 }))).toBe('word_password_protected');
    expect(await run(new Response('too big', { status: 413 }))).toBe('word_too_large');
    expect(await run(new Response('boom', { status: 500 }))).toBe('word_conversion_failed');
    expect(await run(new Response('not a pdf', { status: 200 }))).toBe('word_conversion_failed');
    expect(await run(new TypeError('fetch failed'))).toBe('word_conversion_failed');
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect(await run(timeout)).toBe('word_conversion_failed');
  });

  it('is dark by default: enabled only with SIGN_WORD_CONVERSION_ENABLED=1 and an http(s) SIGN_WORD_CONVERTER_URL', () => {
    expect(wordConverterFromEnv({}).enabled).toBe(false);
    expect(wordConverterFromEnv({ SIGN_WORD_CONVERSION_ENABLED: '1' }).enabled).toBe(false);
    expect(wordConverterFromEnv({ SIGN_WORD_CONVERTER_URL: 'http://converter:3000' }).enabled).toBe(false);
    expect(wordConverterFromEnv({ SIGN_WORD_CONVERSION_ENABLED: 'true', SIGN_WORD_CONVERTER_URL: 'http://converter:3000' }).enabled).toBe(false);
    expect(wordConverterFromEnv({ SIGN_WORD_CONVERSION_ENABLED: '1', SIGN_WORD_CONVERTER_URL: 'converter:3000' }).enabled).toBe(false);
    expect(wordConverterFromEnv({ SIGN_WORD_CONVERSION_ENABLED: '1', SIGN_WORD_CONVERTER_URL: 'http://converter:3000' }).enabled).toBe(true);
  });
});

function uploadHarness(words: WordConversionPort | undefined) {
  const repo = {
    getEnvelopeDetail: vi.fn(async () => ({ id: ENV, subject: 'Offer', status: 'DRAFT', created_by: USER, source_application: 'aramo-sign', created_at: new Date(), sent_at: null, completed_at: null, declined_at: null, voided_at: null, expires_at: null, message: null, documents: [], signers: [], revision: 4, routing_mode: 'PARALLEL' })),
    addDraftDocument: vi.fn(async (i: { title: string; byte_size: number }) => ({ id: 'd1', title: i.title, ordinal: 1, byte_size: i.byte_size, revision: 5 })),
  };
  const ctx = { tenantKind: vi.fn(async () => 'BUSINESS'), assertCanAuthor: vi.fn(async () => undefined) };
  const storage = {
    putOwnedSource: vi.fn(async (i: { bytes: Uint8Array }) => ({ source_object_key: 'k', byte_size: i.bytes.byteLength, source_sha256: 'sha' })),
  };
  const gate = { reserveUpload: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
  const u = undefined;
  const svc = new SenderEnvelopeService(
    repo as never, {} as never, ctx as never, { findUserById: vi.fn(async () => null) } as never,
    storage as never, {} as never, gate as never, u, u, u, u, u, u, u, u, u, u, u, u, words,
  );
  return { svc, repo, storage };
}

const docxBody = (filename = 'Offer letter.docx') => ({ filename, content_base64: Buffer.from(minimalDocx()).toString('base64') });

describe('M-A13 R-4 — sender upload with Word conversion', () => {
  it('flag off (or no converter): a Word upload keeps today’s refusal (400 unsupported_file_type)', async () => {
    for (const words of [undefined, wordConverterFromEnv({})]) {
      const { svc } = uploadHarness(words);
      await expect(svc.upload(AUTH, ENV, docxBody(), 'r')).rejects.toMatchObject({ statusCode: 400, context: { details: { reason: 'unsupported_file_type' } } });
    }
  });

  it('flag on: the converted PDF is stored (never the Word file); the title keeps the file name', async () => {
    const pdf = await onePagePdf();
    const words: WordConversionPort = { enabled: true, convert: vi.fn(async () => pdf) };
    const { svc, repo, storage } = uploadHarness(words);
    const out = await svc.upload(AUTH, ENV, docxBody('Offer letter.docx'), 'r');
    expect(out).toMatchObject({ id: 'd1', title: 'Offer letter', page_count: 1 });
    const stored = storage.putOwnedSource.mock.calls[0]?.[0] as unknown as { content_type: string; filename: string; bytes: Uint8Array };
    expect(stored.content_type).toBe('application/pdf');
    expect(stored.filename).toBe('Offer letter.pdf');
    expect(Buffer.from(stored.bytes).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(repo.addDraftDocument).toHaveBeenCalledWith(expect.objectContaining({ title: 'Offer letter', content_type: 'application/pdf' }));
    expect(words.convert).toHaveBeenCalledWith(expect.objectContaining({ filename: 'Offer letter.docx' }));
  });

  it('flag on: .doc is accepted too; .rtf / .odt stay refused', async () => {
    const words: WordConversionPort = { enabled: true, convert: vi.fn(async () => onePagePdf()) };
    const { svc } = uploadHarness(words);
    await expect(svc.upload(AUTH, ENV, docxBody('memo.doc'), 'r')).resolves.toMatchObject({ title: 'memo' });
    await expect(svc.upload(AUTH, ENV, docxBody('memo.rtf'), 'r')).rejects.toMatchObject({ context: { details: { reason: 'unsupported_file_type' } } });
  });

  it('maps conversion refusals: too large 413, password-protected 422, could not convert 422', async () => {
    for (const [reason, status] of [['word_too_large', 413], ['word_password_protected', 422], ['word_conversion_failed', 422]] as const) {
      const words: WordConversionPort = { enabled: true, convert: vi.fn(async () => { throw new WordConversionError(reason, 'x'); }) };
      const { svc, storage } = uploadHarness(words);
      await expect(svc.upload(AUTH, ENV, docxBody(), 'r')).rejects.toMatchObject({ statusCode: status, context: { details: { reason } } });
      expect(storage.putOwnedSource).not.toHaveBeenCalled();
    }
  });
});

describe('M-A13 R-4 — sender context capability', () => {
  const tenants = { findById: async () => ({ id: TENANT, name: 'Acme', kind: 'BUSINESS' }), findSlugById: async () => 'acme', findOrganizationNameById: async () => 'Acme' };
  const identity = { findUserById: async () => ({ email: 'u@x.test', display_name: 'U' }), findMembership: async () => null, findRoleKeysForMembership: async () => [] };
  const u = undefined;
  it('word_conversion_enabled follows the converter port (false when absent)', async () => {
    expect((await new SenderContextService(tenants as never, identity as never).context(AUTH, 'r')).word_conversion_enabled).toBe(false);
    const on = { enabled: true, convert: vi.fn() } as WordConversionPort;
    expect((await new SenderContextService(tenants as never, identity as never, u, u, u, u, u, u, on).context(AUTH, 'r')).word_conversion_enabled).toBe(true);
  });
});

// One real-container test: SIGN_WORD_CONVERTER_TEST_URL=http://localhost:3000 with a pinned
// Gotenberg (LibreOffice) container running. Skipped by default.
describe.skipIf(!process.env['SIGN_WORD_CONVERTER_TEST_URL'])('M-A13 R-4 — real converter container', () => {
  it('converts a .docx to a one-page PDF', async () => {
    const adapter = new LibreOfficeWordConverterAdapter(process.env['SIGN_WORD_CONVERTER_TEST_URL'] ?? '');
    const pdf = await adapter.convert({ bytes: minimalDocx(), filename: 'hello.docx' });
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  }, 90_000);
});

