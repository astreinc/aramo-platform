// PlacementProcess migration SQL generator — Track 3 / E1-a §5c/§5d.
//
// Builds the migration AST (sql-ast.ts) from the AUTHORITATIVE typed lifecycle
// registry (../lifecycle) plus the physical table metadata below, then emits
// deterministic SQL. `generatePlacementMigrationSql()` is the single entry
// point; the committed migration file IS its output, and CI asserts
// byte-equality (ci/scripts/verify-placement-sql.ts).
//
// The registry drives: the PlacementState enum values, the 14 UPDATE
// transition branches, and the BEFORE INSERT guard's DUPLICATE_GUARD_INACTIVE
// NOT-IN list. None of those is hand-written here — they are read from
// LEGAL_TRANSITIONS / PLACEMENT_STATES / DUPLICATE_GUARD_INACTIVE (§5c HALT
// condition: no hand-written matrix, terminal set, or duplicate-guard set).

import {
  DUPLICATE_GUARD_INACTIVE,
  LEGAL_TRANSITIONS,
  PLACEMENT_STATES,
} from '../lifecycle/placement-lifecycle.js';

import { emitMigration } from './sql-ast.js';
import type {
  LifecycleTrigger,
  RejectTrigger,
  SqlEnum,
  SqlForeignKey,
  SqlIndex,
  SqlMigration,
  SqlTable,
  TransitionBranch,
} from './sql-ast.js';

// ---------------------------------------------------------------------------
// Physical names (§3).
// ---------------------------------------------------------------------------

const SCHEMA = 'placement';
const PROCESS_TABLE = 'PlacementProcess';
const EVENT_TABLE = 'PlacementProcessEvent';
const STATE_ENUM = 'PlacementState';
const EVENT_TYPE_ENUM = 'PlacementEventType';
const STATE_COLUMN = 'state';

// The duplicate key (§5, §9): at most one live attempt per this pair.
const KEY_COLUMNS = ['tenant_id', 'submittal_id'] as const;

// Every non-state column is pinned byte-identical on UPDATE (§5). All are
// NOT NULL, so equality is correct throughout (no nullable column here).
const IMMUTABLE_COLUMNS = [
  'id',
  'tenant_id',
  'submittal_id',
  'requisition_id',
  'talent_record_id',
  'created_at',
] as const;

// ---------------------------------------------------------------------------
// Tables (§3). PlacementProcess has NO updated_at (§2); UUID v7 app-side, so
// the id carries NO database default (§2 — a DEFAULT gen_random_uuid() would
// emit v4). PlacementProcessEvent mirrors TalentEngagementEvent.
// ---------------------------------------------------------------------------

const PROCESS_TABLE_MODEL: SqlTable = {
  schema: SCHEMA,
  name: PROCESS_TABLE,
  comment: [
    'PlacementProcess — ONE commitment attempt for ONE talent against ONE',
    'requisition, originating from ONE submittal, at a specific point in time',
    '(§11 identity contract). submittal_id is intentionally NOT unique --',
    'multiple attempts per submittal are expected (re-offer after fallthrough).',
    'Only one may be LIVE at a time, enforced by the BEFORE INSERT guard below,',
    'not by a uniqueness constraint. Lineage is submittal_id, never pipeline_id.',
    'id is a UUID v7 generated app-side -- no database default (§2).',
  ],
  columns: [
    { name: 'id', type: 'UUID', nullable: false },
    { name: 'tenant_id', type: 'UUID', nullable: false },
    { name: 'submittal_id', type: 'UUID', nullable: false },
    { name: 'requisition_id', type: 'UUID', nullable: false },
    { name: 'talent_record_id', type: 'UUID', nullable: false },
    { name: STATE_COLUMN, type: `"${SCHEMA}"."${STATE_ENUM}"`, nullable: false },
    { name: 'created_at', type: 'TIMESTAMPTZ(6)', nullable: false, default: 'CURRENT_TIMESTAMP' },
  ],
  primaryKey: ['id'],
};

const EVENT_TABLE_MODEL: SqlTable = {
  schema: SCHEMA,
  name: EVENT_TABLE,
  comment: [
    'PlacementProcessEvent — append-only audit log of PlacementProcess events.',
    'Intra-schema FK to PlacementProcess (permitted -- §3). Absolutely immutable',
    'at the database layer: no UPDATE surface, no DELETE surface (§3).',
    'id is a UUID v7 generated app-side -- no database default (§2).',
  ],
  columns: [
    { name: 'id', type: 'UUID', nullable: false },
    { name: 'tenant_id', type: 'UUID', nullable: false },
    { name: 'placement_process_id', type: 'UUID', nullable: false },
    { name: 'event_type', type: `"${SCHEMA}"."${EVENT_TYPE_ENUM}"`, nullable: false },
    { name: 'event_payload', type: 'JSONB', nullable: false },
    { name: 'created_at', type: 'TIMESTAMPTZ(6)', nullable: false, default: 'CURRENT_TIMESTAMP' },
  ],
  primaryKey: ['id'],
};

// ---------------------------------------------------------------------------
// Enums, indexes, FK.
// ---------------------------------------------------------------------------

// PlacementState enum values are the registry's state order (§5c — generated,
// never hand-listed).
const STATE_ENUM_MODEL: SqlEnum = {
  schema: SCHEMA,
  name: STATE_ENUM,
  values: PLACEMENT_STATES,
};

const EVENT_TYPE_ENUM_MODEL: SqlEnum = {
  schema: SCHEMA,
  name: EVENT_TYPE_ENUM,
  values: ['state_transition'],
};

const INDEXES: readonly SqlIndex[] = [
  // (tenant, submittal): duplicate-guard lookup + lineage read.
  {
    schema: SCHEMA,
    table: PROCESS_TABLE,
    name: `${PROCESS_TABLE}_tenant_id_submittal_id_idx`,
    columns: ['tenant_id', 'submittal_id'],
  },
  // (tenant, requisition): read at capacity/reporting time (§3b).
  {
    schema: SCHEMA,
    table: PROCESS_TABLE,
    name: `${PROCESS_TABLE}_tenant_id_requisition_id_idx`,
    columns: ['tenant_id', 'requisition_id'],
  },
  // (tenant, talent_record): read at offer time (§3b).
  {
    schema: SCHEMA,
    table: PROCESS_TABLE,
    name: `${PROCESS_TABLE}_tenant_id_talent_record_id_idx`,
    columns: ['tenant_id', 'talent_record_id'],
  },
  // event-log reads mirror TalentEngagementEvent.
  {
    schema: SCHEMA,
    table: EVENT_TABLE,
    name: `${EVENT_TABLE}_tenant_id_placement_process_id_idx`,
    columns: ['tenant_id', 'placement_process_id'],
  },
  {
    schema: SCHEMA,
    table: EVENT_TABLE,
    name: `${EVENT_TABLE}_placement_process_id_created_at_idx`,
    columns: ['placement_process_id', 'created_at'],
  },
];

const FOREIGN_KEYS: readonly SqlForeignKey[] = [
  {
    schema: SCHEMA,
    table: EVENT_TABLE,
    name: `${EVENT_TABLE}_placement_process_id_fkey`,
    column: 'placement_process_id',
    refSchema: SCHEMA,
    refTable: PROCESS_TABLE,
    refColumn: 'id',
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  },
];

// ---------------------------------------------------------------------------
// Triggers.
// ---------------------------------------------------------------------------

// The 14 UPDATE branches, read from the registry's ordered edge list (§5c).
const TRANSITION_BRANCHES: readonly TransitionBranch[] = LEGAL_TRANSITIONS.map((t) => ({
  from: t.from,
  to: t.to,
}));

const LIFECYCLE_TRIGGER: LifecycleTrigger = {
  schema: SCHEMA,
  table: PROCESS_TABLE,
  functionName: 'enforce_placement_process_lifecycle',
  triggerName: 'trg_enforce_placement_process_lifecycle',
  stateColumn: STATE_COLUMN,
  keyColumns: KEY_COLUMNS,
  immutableColumns: IMMUTABLE_COLUMNS,
  transitions: TRANSITION_BRANCHES,
  // DERIVED from lifecycle position (§4c) -- the TERMINAL states. STARTED is
  // ENGAGED, deliberately absent, so a started placement still blocks a
  // second attempt (§5).
  duplicateGuardInactive: DUPLICATE_GUARD_INACTIVE,
  transitionViolationMessage:
    'PlacementProcess permits only the 14 legal state transitions (§4) and only the state column may change -- every other column is pinned byte-identical -- this update is neither a legal transition nor a column-identical move',
  duplicateViolationMessage:
    'PlacementProcess permits at most one live attempt per (tenant_id, submittal_id) -- a placement in a non-terminal state (lifecycle position not TERMINAL, STARTED included as ENGAGED) already exists for this pair',
};

const REJECT_TRIGGERS: readonly RejectTrigger[] = [
  {
    schema: SCHEMA,
    table: EVENT_TABLE,
    functionName: 'reject_placement_process_event_update',
    triggerName: 'trg_reject_placement_process_event_update',
    op: 'UPDATE',
    message: 'PlacementProcessEvent is append-only and absolutely immutable (§3) -- UPDATE is not permitted',
  },
  {
    schema: SCHEMA,
    table: EVENT_TABLE,
    functionName: 'reject_placement_process_event_delete',
    triggerName: 'trg_reject_placement_process_event_delete',
    op: 'DELETE',
    message: 'PlacementProcessEvent is append-only and absolutely immutable (§3) -- DELETE is not permitted',
  },
];

// ---------------------------------------------------------------------------
// Assembly + public API.
// ---------------------------------------------------------------------------

export function buildPlacementMigrationModel(): SqlMigration {
  return {
    schemaName: SCHEMA,
    headerComment: [
      'PlacementProcess spine — Track 3 / E1-a init migration.',
      '',
      'GENERATED ARTIFACT -- do NOT edit by hand. Produced by',
      'libs/placement/src/lib/generator from the typed lifecycle registry',
      '(src/lib/lifecycle). Regenerate with `npm run placement:sql:generate`',
      'CI asserts byte-equality with `npm run placement:sql:check` (§5c).',
    ],
    enums: [STATE_ENUM_MODEL, EVENT_TYPE_ENUM_MODEL],
    tables: [PROCESS_TABLE_MODEL, EVENT_TABLE_MODEL],
    indexes: INDEXES,
    foreignKeys: FOREIGN_KEYS,
    lifecycleTrigger: LIFECYCLE_TRIGGER,
    rejectTriggers: REJECT_TRIGGERS,
  };
}

export function generatePlacementMigrationSql(): string {
  return emitMigration(buildPlacementMigrationModel());
}
