// Settings Rebuild Directive 1 — Import read API client.
//
// Wraps the libs/import READ surface (the only part wired this PR — run/config
// is a later increment, so there is deliberately no run() here that would be a
// dead knob):
//   GET /v1/imports                 -> { items: ImportBatchView[] }
//   GET /v1/imports/:id/failures    -> { items: ImportFailureView[] }
//
// Both gate on `import:read` (seeded for the operational tier in this PR).

import { apiClient } from '@aramo/fe-foundation';

import type { ImportBatchView, ImportFailureView } from './admin-types';

export const IMPORTS_PATH = '/v1/imports';

export async function fetchImports(): Promise<readonly ImportBatchView[]> {
  const res = await apiClient.get<{ items: ImportBatchView[] }>(IMPORTS_PATH);
  return res.items;
}

export async function fetchImportFailures(
  importBatchId: string,
): Promise<readonly ImportFailureView[]> {
  const res = await apiClient.get<{ items: ImportFailureView[] }>(
    `${IMPORTS_PATH}/${encodeURIComponent(importBatchId)}/failures`,
  );
  return res.items;
}
