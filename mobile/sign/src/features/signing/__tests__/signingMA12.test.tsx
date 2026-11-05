// M-A12 W1-C — signing: "Page n of N", the header overflow "…" (Find, Document details,
// Decline, Ask someone else to sign, Help), Find on the signer text layer (token
// transport) with "No searchable text in this document", and the profile field types
// pre-filled from the signed-in signer's own profile.
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { createGuestSigningClient } from '../../../api/guestSigningClient';
import { ServicesProvider } from '../../../app/ServicesContext';
import type { AppServices } from '../../../app/services';
import { ToastProvider } from '../../../components/Toast';
import { memoryKv, recordingFetch, SIGNING_TOKEN } from '../../../testing/fakes';
import { workspaceWith } from '../../inbox/__tests__/fixtures';
import { SigningFlow } from '../SigningFlow';
import { initialState, tapField, type SigningField } from '../signingMachine';

jest.mock('react-native-pdf', () => 'Pdf');
jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn() }));
jest.setTimeout(30_000);

const BASE = 'https://sign.aramo.ai';
const PDF_B64 = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj\n' +
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\ntrailer << /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
  'latin1',
).toString('base64');

function wrap(children: ReactNode) {
  const { workspace } = workspaceWith(() => ({ status: 200, body: {} }));
  const services = { kv: memoryKv(), workspace } as unknown as AppServices;
  return (
    <ServicesProvider services={services}>
      <ToastProvider>{children}</ToastProvider>
    </ServicesProvider>
  );
}

function signer(textLayerWords: unknown[] = []) {
  return recordingFetch((req) => {
    if (req.url.endsWith('/disclosure-text'))
      return { status: 200, body: { disclosure_version: '1.0', text: 'T', text_sha256: 'c'.repeat(64), message: null } };
    if (req.url.endsWith('/signing/document'))
      return {
        status: 200,
        body: { documents: [{ document_id: 'doc-1', title: 'Offer', ordinal: 1 }], fields: [], message: null, can_delegate: true },
      };
    if (req.url.endsWith('/signing/source')) return { status: 200, body: { source_base64: PDF_B64, content_type: 'application/pdf' } };
    if (req.url.endsWith('/text-layer')) return { status: 200, body: { document_id: 'doc-1', pages: [{ page: 1, words: textLayerWords }] } };
    return { status: 200, body: {} };
  });
}

async function openFields(net: ReturnType<typeof signer>) {
  const session = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(SIGNING_TOKEN);
  render(wrap(<SigningFlow session={session} signerName="" signedIn={false} subject="Offer" senderName="Northwind" onDone={jest.fn()} />));
  await waitFor(() => expect(screen.getByTestId('consent-check')).toBeTruthy(), { timeout: 15_000 });
  fireEvent.press(screen.getByTestId('consent-check'));
  fireEvent.press(screen.getByTestId('consent-continue'));
  await waitFor(() => expect(screen.getByTestId('signing-primary')).toBeTruthy(), { timeout: 15_000 });
}

describe('signing (M-A12 W1-C)', () => {
  it('shows "Page n of N" with up / down arrows', async () => {
    await openFields(signer());
    await waitFor(() => expect(screen.getByTestId('page-label')).toBeTruthy());
    expect(screen.getByTestId('page-label').props.children).toBe('Page 1 of 2');
    expect(screen.getByTestId('page-prev').props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(screen.getByTestId('page-next'));
    expect(screen.getByTestId('page-label').props.children).toBe('Page 2 of 2');
  });

  it('the overflow menu has Find, Document details, Decline, Ask someone else to sign, Help', async () => {
    await openFields(signer());
    fireEvent.press(screen.getByTestId('signing-more'));
    for (const id of ['more-find', 'more-details', 'more-decline', 'delegate-open', 'more-help'])
      expect(screen.getByTestId(id)).toBeTruthy();
  });

  it('Find reads the signer text layer on the token transport; an image-only PDF says so', async () => {
    const net = signer([]);
    await openFields(net);
    fireEvent.press(screen.getByTestId('signing-more'));
    fireEvent.press(screen.getByTestId('more-find'));
    await waitFor(() =>
      expect(screen.getByTestId('find-status').props.children).toBe('No searchable text in this document'),
    );
    const call = net.calls.find((c) => c.url.endsWith('/v1/sign/signing/documents/doc-1/text-layer'));
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ token: SIGNING_TOKEN });
  });

  it('Find counts matches and steps through them', async () => {
    await openFields(signer([{ t: 'Offer', x: 0.1, y: 0.1, w: 0.1, h: 0.02 }, { t: 'offer', x: 0.3, y: 0.1, w: 0.1, h: 0.02 }]));
    fireEvent.press(screen.getByTestId('signing-more'));
    fireEvent.press(screen.getByTestId('more-find'));
    fireEvent.changeText(screen.getByTestId('find-input'), 'offer');
    await waitFor(() => expect(screen.getByTestId('find-status').props.children).toBe('1 of 2'));
    fireEvent.press(screen.getByTestId('find-next'));
    expect(screen.getByTestId('find-status').props.children).toBe('2 of 2');
  });
});

describe('profile field types (W1-C.4)', () => {
  const f = (type: string): SigningField => ({
    field_id: type,
    document_id: 'd',
    field_type: type,
    page_number: 0,
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    required: true,
  });
  it('open the text sheet pre-filled from the signer profile, editable', () => {
    const s = initialState(['FIRST_NAME', 'LAST_NAME', 'EMAIL', 'COMPANY', 'TITLE'].map(f));
    const prefill = (t: string) => ({ FIRST_NAME: 'Priya', COMPANY: 'Northwind' })[t] ?? null;
    expect(tapField(s, 'FIRST_NAME', { signerName: '', prefill }).effect).toEqual({ kind: 'text', fieldId: 'FIRST_NAME', initial: 'Priya' });
    expect(tapField(s, 'COMPANY', { signerName: '', prefill }).effect).toMatchObject({ initial: 'Northwind' });
    expect(tapField(s, 'TITLE', { signerName: '', prefill }).effect).toMatchObject({ kind: 'text', initial: '' });
    // A guest link without a profile gets an empty sheet.
    expect(tapField(s, 'EMAIL', { signerName: '' }).effect).toMatchObject({ kind: 'text', initial: '' });
  });
});
