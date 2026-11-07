// M-A13 #7 — "Save a copy": Android writes the executed PDF into the folder the user
// picks; iOS hands it to the share sheet (Save to Files). Same executed fetch as Share.
import { workspaceWith } from '../../inbox/__tests__/fixtures';
import { SAVE_FAILED, saveCompleted, savedMessage, type SaveFolderPort } from '../saveCopy';
import {
  sentShareTarget,
  SHARE_NOT_ALLOWED,
  SHARE_NOT_READY,
  type ShareFilePort,
  type ShareSheetPort,
} from '../shareCompleted';

const EXECUTED = {
  envelope_id: 'e1',
  documents: [
    { envelope_document_id: 'd1', title: 'MSA', executed_sha256: 'x', byte_size: 3, executed_base64: 'JVBE' },
    { envelope_document_id: 'd2', title: 'MSA', executed_sha256: 'z', byte_size: 3, executed_base64: 'JVBF' },
  ],
  certificate: null,
};

function ports(folderOpts: { cancel?: boolean; failWrite?: boolean; failPick?: boolean } = {}) {
  const written: { name: string; base64: string }[] = [];
  const shared: string[] = [];
  const temp: string[] = [];
  const files: ShareFilePort = {
    writeTemp: async (name) => {
      temp.push(name);
      return `file:///cache/x/${name}`;
    },
    remove: () => undefined,
  };
  const sheet: ShareSheetPort = {
    available: async () => true,
    open: async (uri) => {
      shared.push(uri);
    },
  };
  const folder: SaveFolderPort = {
    pick: async () => {
      if (folderOpts.failPick) throw new Error('picker');
      if (folderOpts.cancel) return null;
      return {
        writePdf: async (name, base64) => {
          if (folderOpts.failWrite) throw new Error('write');
          written.push({ name, base64 });
        },
      };
    },
  };
  return { files, sheet, folder, written, shared, temp };
}

const noGuest = { open: jest.fn() };
const target = sentShareTarget('e1', 'MSA', 'COMPLETED');

describe('saveCompleted on Android', () => {
  it('writes every executed PDF into the chosen folder (nothing via the share sheet)', async () => {
    const p = ports();
    const { net, workspace } = workspaceWith(() => ({ status: 200, body: EXECUTED }));
    const r = await saveCompleted(target, { workspace, guest: noGuest, platform: 'android', ...p });
    expect(r).toEqual({ kind: 'saved', files: 2 });
    expect(net.calls[0]!.url).toMatch(/\/v1\/sign\/sender\/envelopes\/e1\/executed$/);
    expect(p.written).toEqual([
      { name: 'MSA.pdf', base64: 'JVBE' },
      { name: 'MSA.pdf', base64: 'JVBF' },
    ]);
    expect(p.shared).toEqual([]);
    expect(p.temp).toEqual([]);
  });

  it('backing out of the picker is a quiet cancel', async () => {
    const p = ports({ cancel: true });
    const { workspace } = workspaceWith(() => ({ status: 200, body: EXECUTED }));
    expect(
      await saveCompleted(target, { workspace, guest: noGuest, platform: 'android', ...p }),
    ).toEqual({ kind: 'cancelled' });
    expect(p.written).toEqual([]);
  });

  it('a folder that cannot be written says so', async () => {
    const p = ports({ failWrite: true });
    const { workspace } = workspaceWith(() => ({ status: 200, body: EXECUTED }));
    expect(
      await saveCompleted(target, { workspace, guest: noGuest, platform: 'android', ...p }),
    ).toEqual({ kind: 'refused', message: SAVE_FAILED });
    const q = ports({ failPick: true });
    expect(
      await saveCompleted(target, { workspace, guest: noGuest, platform: 'android', ...q }),
    ).toEqual({ kind: 'refused', message: SAVE_FAILED });
  });

  it('not ready yet (409) is refused before the picker opens', async () => {
    const p = ports();
    const pick = jest.spyOn(p.folder, 'pick');
    const { workspace } = workspaceWith(() => ({
      status: 409,
      body: { error: { code: 'not_ready', message: 'x', details: {} } },
    }));
    expect(
      await saveCompleted(target, { workspace, guest: noGuest, platform: 'android', ...p }),
    ).toEqual({ kind: 'refused', message: SHARE_NOT_READY });
    expect(pick).not.toHaveBeenCalled();
  });
});

describe('saveCompleted on iOS', () => {
  it('opens the share sheet (Save to Files) with the executed PDF', async () => {
    const p = ports();
    const pick = jest.spyOn(p.folder, 'pick');
    const { workspace } = workspaceWith(() => ({ status: 200, body: EXECUTED }));
    const r = await saveCompleted(target, { workspace, guest: noGuest, platform: 'ios', ...p });
    expect(r).toEqual({ kind: 'saved', files: 2 });
    expect(p.shared).toHaveLength(2);
    expect(pick).not.toHaveBeenCalled();
  });
});

describe('saveCompleted', () => {
  it('refuses without a completed target and touches nothing', async () => {
    const p = ports();
    const { net, workspace } = workspaceWith(() => ({ status: 200, body: {} }));
    expect(
      await saveCompleted(sentShareTarget('e1', 'MSA', 'IN_PROGRESS' as never), {
        workspace,
        guest: noGuest,
        platform: 'android',
        ...p,
      }),
    ).toEqual({ kind: 'refused', message: SHARE_NOT_ALLOWED });
    expect(net.calls).toHaveLength(0);
  });

  it('confirmation copy', () => {
    expect(savedMessage(1)).toBe('Saved a copy.');
    expect(savedMessage(2)).toBe('Saved 2 copies.');
  });
});
