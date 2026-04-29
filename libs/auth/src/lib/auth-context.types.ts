// Consumer types per API Contracts Phase 1 §1 — the three external surfaces
// the program serves. Closed enum.
export const CONSUMER_TYPES = ['recruiter', 'portal', 'ingestion'] as const;
export type ConsumerType = (typeof CONSUMER_TYPES)[number];

export interface AuthContext {
  // JWT subject — the authenticated principal (user id or service id).
  sub: string;
  consumer_type: ConsumerType;
  tenant_id: string;
  scopes: string[];
  iat: number;
  exp: number;
}
