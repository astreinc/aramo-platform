// M-A12 W1-A / W1-B — the self-sign document list and the values each placed field shows
// and sends (pre-filled from the user's own profile, editable).
import type { EditorField } from '../../editor/editorReducer';
import type { SigningField } from '../../signing/signingMachine';
import {
  canFinish,
  displayFill,
  docMenu,
  fillValue,
  matchServerFields,
  moveDoc,
  pageCountLabel,
  placedOnServer,
  removeDoc,
  renameDoc,
  SELF_COPY,
  selfSubject,
  type SelfContext,
  type SelfDoc,
} from '../selfSignModel';

const PAGE = { width: 612, height: 792 };
const doc = (key: string, over: Partial<SelfDoc> = {}): SelfDoc => ({
  key,
  title: `Doc ${key}`,
  filename: `${key}.pdf`,
  base64: 'JVBERi0=',
  pages: [PAGE, PAGE],
  serverId: null,
  ...over,
});
const field = (key: string, type: EditorField['type'], over: Partial<EditorField> = {}): EditorField => ({
  key,
  docKey: 'a',
  page: 0,
  recipientKey: 'self',
  type,
  x: 100,
  y: 100,
  width: 200,
  height: 22,
  required: true,
  ...over,
});
const MARK = { dataUrl: 'data:image/png;base64,AAA', method: 'TYPED' as const, value: 'Priya Raman' };
const ctx = (over: Partial<SelfContext> = {}): SelfContext => ({
  profile: { display_name: 'Priya Raman', company: 'Northwind', title: 'Recruiter' },
  email: 'priya@example.com',
  fallbackName: 'Account Name',
  dateFormat: 'DD/MM/YYYY',
  adopted: { SIGNATURE: MARK },
  today: new Date(2026, 10, 5),
  ...over,
});

describe('W1-B documents', () => {
  it('page count for every document; unknown counts are omitted', () => {
    expect(pageCountLabel([PAGE])).toBe('1 page');
    expect(pageCountLabel([PAGE, PAGE, PAGE])).toBe('3 pages');
    expect(pageCountLabel(null)).toBeNull();
  });

  it('rename, move up / down and remove', () => {
    const docs = [doc('a'), doc('b'), doc('c')];
    expect(renameDoc(docs, 'b', '  Offer  ').map((d) => d.title)).toEqual(['Doc a', 'Offer', 'Doc c']);
    expect(renameDoc(docs, 'b', '   ')[1]?.title).toBe('Doc b');
    expect(moveDoc(docs, 'b', -1).map((d) => d.key)).toEqual(['b', 'a', 'c']);
    expect(moveDoc(docs, 'c', 1).map((d) => d.key)).toEqual(['a', 'b', 'c']);
    expect(removeDoc(docs, 'a').map((d) => d.key)).toEqual(['b', 'c']);
    expect(selfSubject(docs)).toBe('Doc a and 2 more');
  });

  it('rename and reorder apply until uploaded; remove always', () => {
    const docs = [doc('a', { serverId: 's1' }), doc('b'), doc('c')];
    expect(docMenu(docs, 'a')).toEqual({ rename: false, up: false, down: false, remove: true });
    expect(docMenu(docs, 'b')).toEqual({ rename: true, up: false, down: true, remove: true });
    expect(docMenu(docs, 'c')).toEqual({ rename: true, up: true, down: false, remove: true });
  });
});

describe('W1-A values', () => {
  it('fills placed fields at once: signature, date in the user format, profile fields', () => {
    expect(displayFill(field('s', 'SIGNATURE'), ctx(), {})).toEqual({ kind: 'image', uri: MARK.dataUrl });
    expect(displayFill(field('d', 'SIGN_DATE'), ctx(), {})).toEqual({ kind: 'text', text: '05/11/2026' });
    expect(displayFill(field('f', 'FIRST_NAME'), ctx(), {})).toEqual({ kind: 'text', text: 'Priya' });
    expect(displayFill(field('l', 'LAST_NAME'), ctx(), {})).toEqual({ kind: 'text', text: 'Raman' });
    expect(displayFill(field('e', 'EMAIL'), ctx(), {})).toEqual({ kind: 'text', text: 'priya@example.com' });
    expect(displayFill(field('c', 'COMPANY'), ctx(), {})).toEqual({ kind: 'text', text: 'Northwind' });
    expect(displayFill(field('t', 'TITLE'), ctx(), {})).toEqual({ kind: 'text', text: 'Recruiter' });
    expect(displayFill(field('x', 'TEXT'), ctx(), {})).toBeNull();
  });

  it('the user can edit a pre-filled value', () => {
    expect(displayFill(field('c', 'COMPANY'), ctx(), { c: 'Acme' })).toEqual({ kind: 'text', text: 'Acme' });
    expect(fillValue(field('c', 'COMPANY'), ctx(), { c: ' Acme ' })).toEqual({ value: 'Acme' });
  });

  it('falls back to the account name when the profile has none', () => {
    expect(displayFill(field('f', 'FIRST_NAME'), ctx({ profile: null }), {})).toEqual({ kind: 'text', text: 'Account' });
  });

  it('sends ISO dates, the adopted mark, check states; never a server-filled name', () => {
    expect(fillValue(field('d', 'SIGN_DATE'), ctx(), {})).toEqual({ value: '2026-11-05' });
    // M-A13 #1 — a TYPED mark sends its text; the page still shows the script PNG.
    expect(fillValue(field('s', 'SIGNATURE'), ctx(), {})).toEqual({ value: 'Priya Raman', method: 'TYPED' });
    expect(fillValue(field('k', 'CHECKBOX'), ctx(), {})).toEqual({ value: 'true' });
    expect(fillValue(field('k', 'CHECKBOX'), ctx(), { k: 'false' })).toEqual({ value: 'false' });
    expect(fillValue(field('n', 'SIGNER_NAME'), ctx(), {})).toBeNull();
  });

  it('Finish needs a signature and every required value', () => {
    expect(canFinish([field('t', 'TEXT')], ctx(), {})).toMatchObject({ ok: false, message: SELF_COPY.needSignature });
    expect(canFinish([field('s', 'SIGNATURE')], ctx({ adopted: {} }), {})).toMatchObject({ ok: false });
    expect(canFinish([field('s', 'SIGNATURE'), field('t', 'TEXT')], ctx(), {})).toMatchObject({
      ok: false,
      message: SELF_COPY.needValues,
      fieldKey: 't',
    });
    expect(canFinish([field('s', 'SIGNATURE'), field('t', 'TEXT')], ctx(), { t: 'x' }).ok).toBe(true);
  });
});

describe('matching the server fields to the placed fields', () => {
  it('pairs by document, page, type and nearest position', () => {
    const docs = [doc('a', { serverId: 'srv-a' })];
    const fields = [field('s1', 'SIGNATURE', { y: 100 }), field('s2', 'SIGNATURE', { y: 600 })];
    const placed = placedOnServer(fields, docs);
    const server = (id: string, y: number): SigningField => ({
      field_id: id,
      document_id: 'srv-a',
      field_type: 'SIGNATURE',
      page_number: 0,
      x: 100,
      y,
      width: 200,
      height: 22,
      required: true,
    });
    // PDF y is bottom-up: the field placed lower on the page has the smaller y.
    const pairs = matchServerFields([server('B', 792 - 600 - 22), server('A', 792 - 100 - 22)], placed);
    expect(pairs.map((p) => [p.server.field_id, p.field?.key])).toEqual([
      ['B', 's2'],
      ['A', 's1'],
    ]);
    expect(matchServerFields([{ ...server('C', 0), field_type: 'TEXT' }], placed)[0]?.field).toBeNull();
  });
});
