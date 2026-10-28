// A document as a file:// URI for the native renderer, written into the app's own temp
// folder and deleted when the viewer closes (M-A7 §4 R-7; documentTempFiles.ts).
// react-native-pdf renders a file:// source in place: it writes no cache copy of its own.
import { useEffect, useState } from 'react';

import type { DocumentTempFiles, TempPdfLease } from './documentTempFiles';
import { documentTempFiles } from './documentTempFilesNative';

export type LocalPdfSource =
  | { readonly kind: 'base64'; readonly base64: string }
  | {
      readonly kind: 'remote';
      readonly uri: string;
      readonly headers: Readonly<Record<string, string>>;
    };

export type LocalPdf =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly uri: string }
  | { readonly status: 'failed' };

const LOADING: LocalPdf = { status: 'loading' };

interface Shown {
  readonly base64: string | null;
  readonly url: string | null;
  readonly headersKey: string | null;
  readonly pdf: LocalPdf;
}

export function useLocalPdf(
  source: LocalPdfSource,
  files: DocumentTempFiles = documentTempFiles,
): LocalPdf {
  const [shown, setShown] = useState<Shown | null>(null);
  // Primitive dependencies: callers pass a fresh source object on every render.
  const base64 = source.kind === 'base64' ? source.base64 : null;
  const url = source.kind === 'remote' ? source.uri : null;
  const headersKey = source.kind === 'remote' ? JSON.stringify(source.headers) : null;

  useEffect(() => {
    let live = true;
    let release: (() => void) | null = null;
    const show = (pdf: LocalPdf) => setShown({ base64, url, headersKey, pdf });
    const acquire: Promise<TempPdfLease> =
      base64 !== null
        ? Promise.resolve().then(() => files.acquireBase64(base64))
        : files.download(url ?? '', JSON.parse(headersKey ?? '{}') as Record<string, string>);
    acquire.then(
      (lease) => {
        if (!live) {
          lease.release(); // the viewer closed first
          return;
        }
        release = lease.release;
        show({ status: 'ready', uri: lease.uri });
      },
      () => {
        if (live) show({ status: 'failed' });
      },
    );
    return () => {
      live = false;
      release?.();
    };
  }, [base64, url, headersKey, files]);

  // A result for an earlier source is never shown for the current one.
  return shown && shown.base64 === base64 && shown.url === url && shown.headersKey === headersKey
    ? shown.pdf
    : LOADING;
}
