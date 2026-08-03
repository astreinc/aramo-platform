import { describe, expect, it } from 'vitest';

import {
  DUPLICATE_GUARD_INACTIVE,
  LEGAL_TRANSITIONS,
  PLACEMENT_STATES,
} from '../lib/lifecycle/placement-lifecycle.js';
import {
  buildPlacementMigrationModel,
  generatePlacementMigrationSql,
} from '../lib/generator/placement-sql-generator.js';
import { assertCommentSafe, emitMigration, type SqlMigration } from '../lib/generator/sql-ast.js';

// A minimal, fully-specified model — KNOWN INPUT → KNOWN SQL (§8). Exercises
// every node kind the emitter handles, small enough to assert exact output.
const KNOWN_MODEL: SqlMigration = {
  schemaName: 'demo',
  headerComment: ['demo header'],
  enums: [{ schema: 'demo', name: 'S', values: ['A', 'B'] }],
  tables: [
    {
      schema: 'demo',
      name: 'T',
      comment: ['a table'],
      columns: [
        { name: 'id', type: 'UUID', nullable: false },
        { name: 'state', type: '"demo"."S"', nullable: false },
      ],
      primaryKey: ['id'],
    },
  ],
  indexes: [{ schema: 'demo', table: 'T', name: 'T_id_idx', columns: ['id'] }],
  foreignKeys: [],
  lifecycleTrigger: {
    schema: 'demo',
    table: 'T',
    functionName: 'fn',
    triggerName: 'trg',
    stateColumn: 'state',
    keyColumns: ['id'],
    immutableColumns: ['id'],
    transitions: [{ from: 'A', to: 'B' }],
    duplicateGuardInactive: ['B'],
    transitionViolationMessage: 'bad transition',
    duplicateViolationMessage: 'dup',
  },
  rejectTriggers: [
    { schema: 'demo', table: 'T', functionName: 'rj', triggerName: 'trgrj', op: 'DELETE', message: 'no delete' },
  ],
};

describe('SQL emitter — known input produces known SQL (§8)', () => {
  const out = emitMigration(KNOWN_MODEL);

  it('emits a deterministic string (pure over the model)', () => {
    expect(emitMigration(KNOWN_MODEL)).toBe(out);
  });

  it('emits the schema, enum and table exactly', () => {
    expect(out).toContain('CREATE SCHEMA IF NOT EXISTS "demo";');
    expect(out).toContain(`CREATE TYPE "demo"."S" AS ENUM ('A', 'B');`);
    expect(out).toContain('    "id" UUID NOT NULL,');
    expect(out).toContain('    CONSTRAINT "T_pkey" PRIMARY KEY ("id")');
  });

  it('emits the INSERT guard NOT-IN list and the ONE-trigger BEFORE INSERT OR UPDATE binding', () => {
    expect(out).toContain(`existing.state NOT IN ('B')`);
    expect(out).toContain(`IF (TG_OP = 'INSERT') THEN`);
    expect(out).toContain(`IF (TG_OP = 'UPDATE') THEN`);
    expect(out).toContain(`BEFORE INSERT OR UPDATE ON "demo"."T"`);
  });

  it('emits the transition branch with the pinned immutable column', () => {
    expect(out).toContain(`OLD.state = 'A' AND NEW.state = 'B'`);
    expect(out).toContain('AND OLD.id = NEW.id');
  });

  it('emits the reject-DELETE trigger', () => {
    expect(out).toContain(`BEFORE DELETE ON "demo"."T"`);
    expect(out).toContain(`'no delete'`);
  });

  it('ends with a single trailing newline', () => {
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });
});

describe('assertCommentSafe — comment hygiene guard', () => {
  it('accepts a clean comment', () => {
    expect(assertCommentSafe('clean comment -- fine')).toBe('clean comment -- fine');
  });
  it('throws on a semicolon (splitter hazard)', () => {
    expect(() => assertCommentSafe('has a ; terminator')).toThrow(/forbidden token/);
  });
  it('throws on a dollar-quote delimiter', () => {
    expect(() => assertCommentSafe('has a $$ delimiter')).toThrow(/forbidden token/);
  });
});

describe('generatePlacementMigrationSql — the real migration', () => {
  const sql = generatePlacementMigrationSql();

  it('is deterministic', () => {
    expect(generatePlacementMigrationSql()).toBe(sql);
  });

  it('emits the PlacementState enum in registry order', () => {
    expect(sql).toContain(
      `CREATE TYPE "placement"."PlacementState" AS ENUM (${PLACEMENT_STATES.map((s) => `'${s}'`).join(', ')});`,
    );
  });

  it('emits exactly the 14 transition branches from the registry', () => {
    for (const t of LEGAL_TRANSITIONS) {
      expect(sql).toContain(`OLD.state = '${t.from}' AND NEW.state = '${t.to}'`);
    }
    const branchCount = (sql.match(/OLD\.state = '[A-Z_]+' AND NEW\.state = '/g) ?? []).length;
    expect(branchCount).toBe(14);
  });

  it('the INSERT guard NOT-IN list is exactly DUPLICATE_GUARD_INACTIVE (STARTED excluded)', () => {
    const notIn = DUPLICATE_GUARD_INACTIVE.map((s) => `'${s}'`).join(', ');
    expect(sql).toContain(`existing.state NOT IN (${notIn})`);
    expect(sql).not.toContain(`NOT IN (${notIn}, 'STARTED')`);
    // STARTED must not appear in the duplicate-guard NOT-IN list at all.
    const notInLine = sql.split('\n').find((l) => l.includes('NOT IN ('));
    expect(notInLine).toBeDefined();
    expect(notInLine).not.toContain('STARTED');
  });

  it('installs the event-log UPDATE and DELETE immutability triggers', () => {
    expect(sql).toContain('BEFORE UPDATE ON "placement"."PlacementProcessEvent"');
    expect(sql).toContain('BEFORE DELETE ON "placement"."PlacementProcessEvent"');
  });

  it('has no semicolon or dollar-quote inside any comment line (splitter hygiene)', () => {
    for (const line of sql.split('\n')) {
      if (line.trimStart().startsWith('--')) {
        expect(line.includes(';'), `comment has ';': ${line}`).toBe(false);
        expect(line.includes('$$'), `comment has $$: ${line}`).toBe(false);
      }
    }
  });

  it('carries the identity contract and the no-hand-edit warning in the header', () => {
    expect(sql).toContain('ONE commitment attempt for ONE talent');
    expect(sql).toContain('GENERATED ARTIFACT');
  });

  it('the model exposes both tables and both enums', () => {
    const model = buildPlacementMigrationModel();
    expect(model.tables.map((t) => t.name)).toEqual(['PlacementProcess', 'PlacementProcessEvent']);
    expect(model.enums.map((e) => e.name)).toEqual(['PlacementState', 'PlacementEventType']);
  });
});
