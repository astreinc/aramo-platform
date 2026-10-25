import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useSyncExternalStore } from 'react';

import { createDraftStore } from '../../../state/draftStore';
import { createEncryptedStore } from '../../../state/encryptedStore';
import { memoryFiles, memoryKv, nodeAesGcm } from '../../../testing/fakes';
import { createDocumentBytesStore } from '../../../features/send/documentBytes';
import type { SenderApi } from '../../../features/send/senderApi';
import { SendFlowController } from '../../../features/send/sendFlowController';
import { RecipientsStep, routingFootnote } from '../RecipientsStep';
import { sentToast } from '../../../features/send/sendCopy';

// The contacts sheet talks to the server; it is covered by its own tests.
jest.mock('../../../features/contacts/ContactsSheet', () => ({ ContactsSheet: () => null }));

function controller() {
  const store = createEncryptedStore({ kv: memoryKv(), cipher: nodeAesGcm, files: memoryFiles() });
  let n = 0;
  return new SendFlowController({
    drafts: createDraftStore(store),
    bytes: createDocumentBytesStore(store),
    api: {} as SenderApi,
    fetchSource: async () => new Uint8Array(),
    isOnline: () => true,
    newId: () => `id-${String(++n).padStart(8, '0')}`,
  });
}

function Harness({ c }: { readonly c: SendFlowController }) {
  const state = useSyncExternalStore(c.subscribe, () => c.snapshot);
  return <RecipientsStep controller={c} state={state} me={null} online />;
}

describe('Recipients step (handoff §4.6, directive §7 C-1 / C-11)', () => {
  it('offers no "Gets a copy" / CC role: every recipient signs', async () => {
    const c = controller();
    await c.open();
    c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' });
    c.addRecipient({ name: 'Sam Roy', email: 'sam@example.com' });
    render(<Harness c={c} />);
    expect(screen.getByText('Who needs to sign?')).toBeTruthy();
    expect(screen.getByText('Dana Lee')).toBeTruthy();
    expect(screen.queryByText(/copy/i)).toBeNull();
    expect(screen.queryByText(/\bcc\b/i)).toBeNull();
    expect(screen.queryByText(/^Signs$/)).toBeNull(); // no Signs / Gets a copy toggle
    expect(screen.queryByLabelText(/copy/i)).toBeNull();
  });

  it('shows the parallel footnote only for parallel routing, and reorders when sequential', async () => {
    const c = controller();
    await c.open();
    c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' });
    c.addRecipient({ name: 'Sam Roy', email: 'sam@example.com' });
    render(<Harness c={c} />);
    expect(screen.getByText(routingFootnote('PARALLEL'))).toBeTruthy();
    expect(screen.queryByLabelText('Move Sam Roy up')).toBeNull();
    await act(async () => c.setRouting('SEQUENTIAL'));
    expect(screen.queryByText('Everyone signs at the same time.')).toBeNull();
    fireEvent.press(screen.getByLabelText('Move Sam Roy up'));
    expect(c.snapshot.draft!.payload.recipients.map((r) => r.name)).toEqual(['Sam Roy', 'Dana Lee']);
  });

  it('removes a recipient', async () => {
    const c = controller();
    await c.open();
    c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' });
    render(<Harness c={c} />);
    fireEvent.press(screen.getByLabelText('Remove Dana Lee'));
    expect(c.snapshot.draft!.payload.recipients).toHaveLength(0);
  });

  it('confirms the send with the signer count', () => {
    expect(sentToast(1)).toBe('Sent to 1 signer');
    expect(sentToast(3)).toBe('Sent to 3 signers');
  });
});
