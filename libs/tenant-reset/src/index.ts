// @aramo/tenant-reset — Track-0 (Tenant Reset & Archive, Directive v1.0
// LOCKED). A repeatable, reviewable, auditable tenant-reset engine with
// dry-run as the default, an append-only ResetBatch record, and an
// immutable checksum-verified archive that gates every delete.
export { PrismaService } from './lib/prisma/prisma.service.js';
export { ResetBatchStore } from './lib/reset-batch.store.js';
export type { CompletedRealRun } from './lib/reset-batch.store.js';
export {
  RESET_REASON,
} from './lib/reset-batch.js';
export type {
  ResetResult,
  EntityCount,
  RowsByEntity,
  RecordResetBatchInput,
  ResetBatch,
} from './lib/reset-batch.js';
export type { PgExec } from './lib/pg-exec.js';
export {
  FileArchiveSink,
  serializeArchive,
  checksumArchive,
} from './lib/archive.js';
export type { ArchiveSink, ArchivePayload } from './lib/archive.js';
export {
  TenantResetService,
  TenantAssertionError,
  RerunRefusedError,
  ArchiveLocationRequiredError,
  ACTIVITY_SCOPE_PREDICATE,
} from './lib/tenant-reset.service.js';
export type {
  ResetBatchRecorder,
  ResetOptions,
  ResetReport,
  ResetScope,
  EntityCountReport,
  UsageEventCheck,
  OrphanCheck,
} from './lib/tenant-reset.service.js';
