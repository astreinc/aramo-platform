// M-A7 §4 R-7: a viewer's document file exists only while the viewer is open.
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { DocumentTempFiles, TempPdfLease } from '../documentTempFiles';
import { useLocalPdf, type LocalPdfSource } from '../useLocalPdf';

function fakeFiles() {
  const live = new Set<string>();
  let n = 0;
  let pending: ((l: TempPdfLease) => void) | null = null;
  const lease = (uri: string): TempPdfLease => {
    live.add(uri);
    return { uri, release: () => live.delete(uri) };
  };
  const files: DocumentTempFiles = {
    acquireBase64: () => lease(`file:///cache/aramo-docs/b${++n}.pdf`),
    download: () =>
      new Promise<TempPdfLease>((resolve) => {
        pending = (l) => resolve(l);
      }),
    wipe: () => live.clear(),
  };
  return {
    files,
    live,
    finishDownload: () => pending?.(lease(`file:///cache/aramo-docs/r${++n}.pdf`)),
  };
}

describe('useLocalPdf', () => {
  it('deletes a base64 file when the viewer closes before it was shown', async () => {
    const f = fakeFiles();
    const { unmount } = renderHook(() =>
      useLocalPdf({ kind: 'base64', base64: 'JVBERi0x' }, f.files),
    );
    unmount();
    await act(async () => {});
    expect(f.live.size).toBe(0);
  });

  it('serves a base64 document from a temp file and deletes it on unmount', async () => {
    const f = fakeFiles();
    const { result, unmount } = renderHook(() =>
      useLocalPdf({ kind: 'base64', base64: 'JVBERi0x' }, f.files),
    );
    await waitFor(() =>
      expect(result.current).toEqual({ status: 'ready', uri: 'file:///cache/aramo-docs/b1.pdf' }),
    );
    expect(f.live.size).toBe(1);
    unmount();
    expect(f.live.size).toBe(0);
  });

  it('does not rewrite the file when the caller re-renders with an equal source', async () => {
    const f = fakeFiles();
    const { result, rerender } = renderHook(
      ({ s }: { s: LocalPdfSource }) => useLocalPdf(s, f.files),
      { initialProps: { s: { kind: 'base64', base64: 'JVBERi0x' } } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ s: { kind: 'base64', base64: 'JVBERi0x' } });
    expect(result.current).toEqual({ status: 'ready', uri: 'file:///cache/aramo-docs/b1.pdf' });
    expect(f.live.size).toBe(1);
    rerender({ s: { kind: 'base64', base64: 'JVBERi0y' } });
    // The old document's file is gone at once and never shown for the new source.
    expect(result.current).toEqual({ status: 'loading' });
    await waitFor(() =>
      expect(result.current).toEqual({ status: 'ready', uri: 'file:///cache/aramo-docs/b2.pdf' }),
    );
    expect(f.live).toEqual(new Set(['file:///cache/aramo-docs/b2.pdf']));
  });

  it('deletes a download that finishes after the viewer closed', async () => {
    const f = fakeFiles();
    const { result, unmount } = renderHook(() =>
      useLocalPdf({ kind: 'remote', uri: 'https://sign.aramo.ai/doc', headers: {} }, f.files),
    );
    expect(result.current).toEqual({ status: 'loading' });
    unmount();
    await act(async () => {
      f.finishDownload();
    });
    expect(f.live.size).toBe(0);
  });

  it('serves a download once it lands, and deletes it on unmount', async () => {
    const f = fakeFiles();
    const { result, unmount } = renderHook(() =>
      useLocalPdf({ kind: 'remote', uri: 'https://sign.aramo.ai/doc', headers: {} }, f.files),
    );
    await act(async () => {
      f.finishDownload();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(f.live.size).toBe(1);
    unmount();
    expect(f.live.size).toBe(0);
  });
});
