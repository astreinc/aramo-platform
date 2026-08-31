// L2-I (D1) — the mapping-admin request shape (thin controller validates SHAPE only; the
// service owns all mapping/canonical/authority rules).
export interface AuthorPipelineMappingRequest {
  // The provider disposition/status token (opaque to Aramo).
  readonly provider_token: string;
  // The canonical Pipeline target (recruiter action or non-system disposition reason). Required
  // for EXECUTE_ACTION; the service rejects a non-canonical target (422). Omitted for IGNORE.
  readonly mapped_target?: string;
  readonly disposition?: 'EXECUTE_ACTION' | 'IGNORE';
  readonly authority_mode?: 'external_authority' | 'dual_control';
}
