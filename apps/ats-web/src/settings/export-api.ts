// Settings Rebuild Directive 1 — Export download client.
//
// The export endpoint returns `text/csv`, not JSON, so it cannot go through
// apiClient.get (which always JSON-parses the body). This is a thin raw fetch
// that sends the HttpOnly session cookie (credentials: 'include', same as
// apiClient) and turns the CSV body into a browser download.
//
//   GET /v1/exports/:entity_type   (scope export:read; seeded for tenant_admin
//                                    + tenant_owner this PR) -> text/csv
//
// A real operation against a real backend — never a stub. A failure (e.g. a
// 403 if the token lacks export:read) throws so the caller can surface it; it
// never silently "succeeds".

import type { ExportEntityType } from './admin-types';

export const EXPORTS_PATH = '/v1/exports';

export class ExportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ExportError';
  }
}

// Fetches the CSV for one entity and triggers a browser download named
// `<entity>-export.csv`. Returns the row count is not available from a CSV
// stream, so it resolves void on success. Injectable seams (`fetchImpl`,
// `onBlob`) keep it unit-testable without touching the real DOM/network.
export async function downloadExport(
  entityType: ExportEntityType,
  opts: {
    readonly fetchImpl?: typeof fetch;
    readonly onBlob?: (blob: Blob, filename: string) => void;
  } = {},
): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  const response = await doFetch(
    `${EXPORTS_PATH}/${encodeURIComponent(entityType)}`,
    { method: 'GET', credentials: 'include' },
  );
  if (!response.ok) {
    throw new ExportError(
      response.status,
      response.status === 403
        ? 'You do not have permission to export this data.'
        : `Export failed (${response.status}).`,
    );
  }
  const csv = await response.text();
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const filename = `${entityType}-export.csv`;
  if (opts.onBlob) {
    opts.onBlob(blob, filename);
    return;
  }
  triggerDownload(blob, filename);
}

function triggerDownload(blob: Blob, filename: string): void {
  // Guard for non-DOM/test environments lacking URL.createObjectURL.
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
