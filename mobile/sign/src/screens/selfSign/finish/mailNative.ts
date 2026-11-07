// M-A14 R-2 — the production mail-composer port (expo-mail-composer).
import * as MailComposer from 'expo-mail-composer';

import type { MailComposerPort } from './emailCopy';

export const nativeMailComposer: MailComposerPort = {
  available: () => MailComposer.isAvailableAsync(),
  async compose({ subject, attachments }) {
    const r = await MailComposer.composeAsync({ subject, attachments: [...attachments] });
    return r.status;
  },
};
