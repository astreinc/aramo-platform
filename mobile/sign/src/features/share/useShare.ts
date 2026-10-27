// Share from a screen: runs shareCompleted with the app's services and the native
// ports, shows the refusal as a toast, and reports busy while it works.
import { useRef, useState } from 'react';

import { useServices } from '../../app/ServicesContext';
import { useToast } from '../../components/Toast';
import { shareCompleted, type ShareTarget } from './shareCompleted';
import { nativeShareFiles, nativeShareSheet } from './shareNative';

export function useShare(): {
  readonly busy: boolean;
  readonly share: (target: ShareTarget | null) => void;
} {
  const { workspace, guest } = useServices();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  function share(target: ShareTarget | null): void {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    void shareCompleted(target, {
      workspace,
      guest,
      files: nativeShareFiles,
      sheet: nativeShareSheet,
    })
      .then((r) => {
        if (r.kind === 'refused') toast.show(r.message);
      })
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  }
  return { busy, share };
}
