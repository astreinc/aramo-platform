// Share from a screen: runs shareCompleted with the app's services and the native
// ports, shows the refusal as a toast, and reports busy while it works.
import { useRef, useState } from 'react';
import { Platform } from 'react-native';

import { useServices } from '../../app/ServicesContext';
import { useToast } from '../../components/Toast';
import { saveCompleted, savedMessage, saveOnePdf } from './saveCopy';
import { shareCompleted, type ShareTarget } from './shareCompleted';
import { nativeSaveFolder, nativeShareFiles, nativeShareSheet } from './shareNative';

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

/** UAT CMP-02 — "Download" the PDF on screen (certificate or one document). */
export function useSaveOnePdf(): {
  readonly busy: boolean;
  readonly save: (pdf: { readonly title: string; readonly base64: string }) => void;
} {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  function save(pdf: { readonly title: string; readonly base64: string }): void {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    void saveOnePdf(pdf, { folder: nativeSaveFolder, files: nativeShareFiles, sheet: nativeShareSheet, platform: Platform.OS })
      .then((r) => {
        if (r.kind === 'refused') toast.show(r.message);
        else if (r.kind === 'saved' && Platform.OS === 'android') toast.show('Downloaded.');
      })
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  }
  return { busy, save };
}

/** M-A13 #7 — "Save a copy": Android folder picker; iOS share sheet (Save to Files). */
export function useSaveCopy(): {
  readonly busy: boolean;
  readonly save: (target: ShareTarget | null) => void;
} {
  const { workspace, guest } = useServices();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  function save(target: ShareTarget | null): void {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    void saveCompleted(target, {
      workspace,
      guest,
      files: nativeShareFiles,
      sheet: nativeShareSheet,
      folder: nativeSaveFolder,
      platform: Platform.OS,
    })
      .then((r) => {
        if (r.kind === 'refused') toast.show(r.message);
        // iOS: the share sheet itself confirms; Android says where it went.
        else if (r.kind === 'saved' && Platform.OS === 'android') toast.show(savedMessage(r.files));
      })
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  }
  return { busy, save };
}
