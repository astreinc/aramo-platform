// Commercial Plans Amendment A1 — per-tenant storage measurement. Objects the
// signing engine MUST keep (signed copies, execution certificates) are recorded
// against the tenant's storage, never refused: a full quota can stop new
// uploads but never a signature completing. Optional; the composition root
// binds it to the commercial capacity ledger. Failures never break signing.

export const STORAGE_ACCOUNTING_PORT = 'STORAGE_ACCOUNTING_PORT';

export interface StorageAccountingPort {
  recordKept(input: { tenant_id: string; ref: string; bytes: number }): Promise<void>;
}
