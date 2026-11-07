// M-A14 §1 items 1–2 — "+ › Sign Document" opens the Add Documents sheet over Home (a03).
// The source runs from the sheet; the picked document is handed to the Sign Document
// screen in memory (selfSignHandoff) and that screen opens on it (a06). Cancelling a
// picker keeps the sheet. Templates follows today's plan rule: allowed → the template
// picker in Sign Document; a Personal account without them → Plans (the paywall).
// R-7: never Email or a cloud tile.
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useState } from 'react';

import type { RootStackParamList } from '../../navigation/types';
import { useSenderContext } from '../inbox/queries';
import type { SenderContext } from '../inbox/types';
import {
  AddDocumentsSourceSheet,
  addSourceTiles,
  FILES_NOTE,
  FILES_NOTE_WORD,
  type AddSourceKey,
} from '../send/AddDocumentsSheet';
import { wordUploadEnabled } from '../send/fileValidation';
import { usePhotoEditor } from '../send/photoEdit/PhotoEditor';
import { templatesAvailable } from '../send/templates';
import { putPendingSelfDoc } from './selfSignHandoff';
import { pickSelfDoc } from './selfSignSources';

/** Templates on the sheet: allowed, or the Personal plans prompt (today's side-menu rule). */
export function selfTemplatesTile(context: SenderContext | null | undefined): {
  readonly show: boolean;
  readonly allowed: boolean;
} {
  const allowed = templatesAvailable(context ?? null);
  return { allowed, show: allowed || context?.tenant?.kind === 'PERSONAL' };
}

export function SelfSignEntrySheet({ visible, onClose }: { readonly visible: boolean; readonly onClose: () => void }) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const ctx = useSenderContext();
  const photoEditor = usePhotoEditor();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tpl = selfTemplatesTile(ctx.data);
  const wordAllowed = wordUploadEnabled(ctx.data);

  const close = () => {
    setError(null);
    onClose();
  };

  async function pick(key: AddSourceKey): Promise<void> {
    setError(null);
    if (key === 'templates') {
      close();
      if (tpl.allowed) navigation.navigate('SelfSign', { start: 'templates' });
      else navigation.navigate('Plans', { from: 'templates' });
      return;
    }
    setBusy(true);
    try {
      const r = await pickSelfDoc(key, { editPhoto: photoEditor.edit, wordAllowed });
      if (r.kind === 'cancelled') return;
      if (r.kind === 'refused') {
        setError(r.message);
        return;
      }
      putPendingSelfDoc({ doc: r.doc, source: r.source });
      close();
      navigation.navigate('SelfSign');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AddDocumentsSourceSheet
      visible={visible}
      tiles={addSourceTiles(tpl.show)}
      onPick={(k) => void pick(k)}
      onClose={close}
      busy={busy}
      error={error}
      filesNote={wordAllowed ? FILES_NOTE_WORD : FILES_NOTE}
    >
      {photoEditor.element}
    </AddDocumentsSourceSheet>
  );
}
