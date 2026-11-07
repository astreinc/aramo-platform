// M-A14 R-5 — Email · Share · Save on You're almost there. Share and Save run the M-A13 #7
// paths (shareCompleted / saveCompleted with the native ports); Email runs emailCompleted
// (R-2). Refusals show as a toast; successful hand-offs are counted for the
// "✓ Shared n times" line. One action at a time.
import { useRef, useState } from 'react';
import { Platform } from 'react-native';

import { useServices } from '../../../app/ServicesContext';
import { useToast } from '../../../components/Toast';
import { saveCompleted, savedMessage } from '../../../features/share/saveCopy';
import type { ShareTarget } from '../../../features/share/shareCompleted';
import { shareCompleted } from '../../../features/share/shareCompleted';
import {
  nativeSaveFolder,
  nativeShareFiles,
  nativeShareSheet,
} from '../../../features/share/shareNative';
import { emailCompleted } from './emailCopy';
import { nativeMailComposer } from './mailNative';

export type CopyAction = 'email' | 'share' | 'save';

export function useCopyActions(target: ShareTarget): {
  readonly busy: CopyAction | null;
  readonly handedOff: number;
  readonly run: (action: CopyAction) => void;
} {
  const { workspace, guest } = useServices();
  const toast = useToast();
  const [busy, setBusy] = useState<CopyAction | null>(null);
  const [handedOff, setHandedOff] = useState(0);
  const running = useRef(false);

  async function perform(action: CopyAction): Promise<void> {
    const base = { workspace, guest, files: nativeShareFiles, sheet: nativeShareSheet };
    if (action === 'email') {
      const r = await emailCompleted(target, { ...base, mail: nativeMailComposer });
      if (r.kind === 'refused') toast.show(r.message);
      else if (r.kind !== 'cancelled') setHandedOff((n) => n + 1);
      return;
    }
    if (action === 'share') {
      const r = await shareCompleted(target, base);
      if (r.kind === 'refused') toast.show(r.message);
      else setHandedOff((n) => n + 1);
      return;
    }
    const r = await saveCompleted(target, {
      ...base,
      folder: nativeSaveFolder,
      platform: Platform.OS,
    });
    if (r.kind === 'refused') toast.show(r.message);
    else if (r.kind === 'saved' && Platform.OS === 'android') toast.show(savedMessage(r.files));
  }

  function run(action: CopyAction): void {
    if (running.current) return;
    running.current = true;
    setBusy(action);
    void perform(action).finally(() => {
      running.current = false;
      setBusy(null);
    });
  }

  return { busy, handedOff, run };
}
