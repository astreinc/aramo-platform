// T8-P3 — requisition-ingestion READ client (directive §15). Wraps the two
// existing libs/import requisition-import READ routes, both gated `requisition:
// import:read`. READ-ONLY: there is deliberately NO run()/POST here — the POST
// belongs to the future connector, and an operator-facing run would be a dead
// knob / out-of-scope mutation (§2, §9).
//
//   GET /v1/requisition-imports        -> { items: ImportBatchView[] }
//   GET /v1/requisition-imports/:id    -> ImportBatchView
//
// Uses the shared cookie/session apiClient + ApiError; no raw fetch, no CSRF or
// correlation-id behavior beyond the shared client.

import { apiClient } from '@aramo/fe-foundation';

import type { ImportBatchView } from './types';

export const REQUISITION_IMPORTS_PATH = '/v1/requisition-imports';

export async function listRequisitionImports(): Promise<readonly ImportBatchView[]> {
  const res = await apiClient.get<{ items: ImportBatchView[] }>(REQUISITION_IMPORTS_PATH);
  return res.items;
}

export async function getRequisitionImport(id: string): Promise<ImportBatchView> {
  return apiClient.get<ImportBatchView>(
    `${REQUISITION_IMPORTS_PATH}/${encodeURIComponent(id)}`,
  );
}
