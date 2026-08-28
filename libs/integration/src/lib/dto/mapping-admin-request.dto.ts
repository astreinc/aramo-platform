// L1-D3-A — VMS Lifecycle Mapping Administration request DTOs. Plain interfaces
// (mirrors the connection-management DTO style); the controller validates the body
// EXPLICITLY (unknown keys — e.g. a raw target_status — are REJECTED, DoD #15;
// there is deliberately NO authority_mode field, so DUAL_CONTROL is unauthorable,
// DoD #13). The service re-validates (R4 boundary #2) and the DB CHECK is the
// authoritative backstop (boundary #3).

export interface MappingRowRequest {
  readonly provider_state: string;
  readonly disposition: string;
  readonly mapped_action?: string | null;
}

/** Body for create-draft (POST versions) and replace-draft (PUT versions/:v). */
export interface MappingSetRowsRequest {
  readonly rows: MappingRowRequest[];
}
