// M-A14 R-4 — the paper card's numbers: GET /v1/sign/me/signing-stats returns THIS
// account's own counts { documents_signed, pages_signed } (never third-party or company
// figures). Read defensively: anything but two non-negative whole numbers counts as a
// failure, and the card is hidden rather than showing made-up numbers. Not persisted.
import { useQuery } from '@tanstack/react-query';

import type { WorkspaceClient } from '../../../api/workspaceClient';
import { useServices } from '../../../app/ServicesContext';

export interface SigningStats {
  readonly documentsSigned: number;
  readonly pagesSigned: number;
}

export const SIGNING_STATS_PATH = '/v1/sign/me/signing-stats';
export const signingStatsKey = ['sign', 'me', 'signing-stats'] as const;

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

export function parseSigningStats(body: unknown): SigningStats | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const documentsSigned = count(b['documents_signed']);
  const pagesSigned = count(b['pages_signed']);
  if (documentsSigned === null || pagesSigned === null) return null;
  return { documentsSigned, pagesSigned };
}

export async function fetchSigningStats(workspace: WorkspaceClient): Promise<SigningStats> {
  // Untyped request: the route is new in M-A14 and may not be in the generated types yet.
  const r = await workspace.request<unknown>({ method: 'GET', path: SIGNING_STATS_PATH });
  const stats = parseSigningStats(r.data);
  if (!stats) throw new Error('signing-stats: unexpected response');
  return stats;
}

export function useSigningStats() {
  const { workspace } = useServices();
  return useQuery({
    queryKey: signingStatsKey,
    queryFn: () => fetchSigningStats(workspace),
    retry: false,
    staleTime: 0,
  });
}

export function documentsLabel(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? 'document' : 'documents'}`;
}

export function sheetsLabel(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? 'sheet' : 'sheets'}`;
}
