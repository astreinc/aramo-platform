// SMS-CONSENT-1 §2 — the send flow: while texts are launched and in the plan but the
// organization has not certified, a note replaces the SMS options (the web shows the same).
import { render, screen } from '@testing-library/react-native';
import { useSyncExternalStore } from 'react';

import { createDraftStore } from '../../../state/draftStore';
import { createEncryptedStore } from '../../../state/encryptedStore';
import { memoryFiles, memoryKv, nodeAesGcm } from '../../../testing/fakes';
import { createDocumentBytesStore } from '../../../features/send/documentBytes';
import type { SenderApi } from '../../../features/send/senderApi';
import { NO_SEND_FEATURES, type SendFeatures } from '../../../features/send/sendFeatures';
import { SendFlowController } from '../../../features/send/sendFlowController';
import { SMS_SEND_NOTE } from '../../../features/account/smsConsentCopy';
import { smsCertificationPending } from '../../../features/account/smsConsent';
import { RecipientsStep } from '../RecipientsStep';

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

function Harness({
  c,
  features,
  smsPending,
}: {
  readonly c: SendFlowController;
  readonly features: SendFeatures;
  readonly smsPending: boolean;
}) {
  const state = useSyncExternalStore(c.subscribe, () => c.snapshot);
  return (
    <RecipientsStep
      controller={c}
      state={state}
      me={null}
      online
      roles
      features={features}
      smsPending={smsPending}
    />
  );
}

async function oneSigner() {
  const c = controller();
  await c.open();
  c.addRecipient({ name: 'Dana Lee', email: 'dana@example.com' });
  return { c, dana: c.snapshot.draft!.payload.recipients[0]! };
}

describe('SMS-CONSENT-1 — send-flow certification note', () => {
  it('reads the sender context: pending only when required and not certified', () => {
    expect(smsCertificationPending(undefined)).toBe(false);
    expect(smsCertificationPending({})).toBe(false);
    expect(
      smsCertificationPending({ sms_certification: { required: false, certified: false } }),
    ).toBe(false);
    expect(
      smsCertificationPending({ sms_certification: { required: true, certified: true } }),
    ).toBe(false);
    expect(
      smsCertificationPending({ sms_certification: { required: true, certified: false } }),
    ).toBe(true);
  });

  it('shows the note instead of the SMS options while not certified', async () => {
    const { c, dana } = await oneSigner();
    render(<Harness c={c} features={NO_SEND_FEATURES} smsPending />);
    expect(screen.getByTestId(`sms-certification-note-${dana.key}`)).toHaveTextContent(
      SMS_SEND_NOTE,
    );
    expect(screen.queryByTestId(`sms-code-${dana.key}`)).toBeNull();
    expect(screen.queryByTestId(`channel-${dana.key}-SMS`)).toBeNull();
  });

  it('no note once certified (or when not required)', async () => {
    const { c, dana } = await oneSigner();
    render(
      <Harness
        c={c}
        features={{ ...NO_SEND_FEATURES, sms: true, smsCode: true }}
        smsPending={false}
      />,
    );
    expect(screen.queryByTestId(`sms-certification-note-${dana.key}`)).toBeNull();
    expect(screen.getByTestId(`sms-code-${dana.key}`)).toBeTruthy();
  });
});
