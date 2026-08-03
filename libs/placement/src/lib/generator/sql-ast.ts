// Deterministic SQL AST + emitter — Track 3 / E1-a §5c/§5d.
//
// The placement migration is a BUILD ARTIFACT. The generator MODELS the
// migration as a structured value (this AST) and the emitter walks it —
// it does NOT interpolate the domain into a raw template (§5d). Track 4
// extends the lifecycle; a typed model survives that, a string-concatenating
// emitter would not.
//
// Determinism (§5c): emission is a pure function of the AST. No Date, no
// randomness, no environment. Node order is the array order the model
// builder fixes explicitly.
//
// Comment hygiene (submittal/CTR migration precedent + splitter guard): the
// integration migration splitter is dollar-quote aware but does NOT strip
// line comments, so a `--` comment line must never contain a literal `;`
// statement terminator or a `$$` dollar-quote delimiter. assertCommentSafe()
// enforces this at generation time so a hazard can never reach the committed
// SQL.

// ---------------------------------------------------------------------------
// AST node types
// ---------------------------------------------------------------------------

export type SqlColumn = {
  readonly name: string;
  readonly type: string; // rendered PG type, e.g. 'UUID', 'TIMESTAMPTZ(6)'
  readonly nullable: boolean;
  readonly default?: string; // rendered default expression, e.g. 'CURRENT_TIMESTAMP'
};

export type SqlEnum = {
  readonly schema: string;
  readonly name: string;
  readonly values: readonly string[];
};

export type SqlTable = {
  readonly schema: string;
  readonly name: string;
  readonly comment: readonly string[];
  readonly columns: readonly SqlColumn[];
  readonly primaryKey: readonly string[];
};

export type SqlIndex = {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly columns: readonly string[];
};

export type SqlForeignKey = {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly column: string;
  readonly refSchema: string;
  readonly refTable: string;
  readonly refColumn: string;
  readonly onDelete: string;
  readonly onUpdate: string;
};

// A single legal transition branch. Column pinning is uniform across all
// branches (every non-state column is NOT NULL here → `=`), so the emitter
// derives the pins from `immutableColumns` rather than repeating them here.
export type TransitionBranch = {
  readonly from: string;
  readonly to: string;
};

// The lifecycle trigger — ONE trigger owning TWO concerns (§5):
//   A. BEFORE UPDATE — the generated 14-edge transition matrix + column scope.
//   B. BEFORE INSERT — the duplicate-live-attempt guard using the generated
//      DUPLICATE_GUARD_INACTIVE classification.
export type LifecycleTrigger = {
  readonly schema: string;
  readonly table: string;
  readonly functionName: string;
  readonly triggerName: string;
  readonly stateColumn: string;
  readonly keyColumns: readonly string[]; // (tenant_id, submittal_id) — the duplicate key
  readonly immutableColumns: readonly string[]; // pinned byte-identical on UPDATE
  readonly transitions: readonly TransitionBranch[]; // the 14 legal edges, ordered
  readonly duplicateGuardInactive: readonly string[]; // NOT IN list for the INSERT guard
  readonly transitionViolationMessage: string;
  readonly duplicateViolationMessage: string;
};

// A static append-only immutability trigger (event log): an unconditional
// RAISE on UPDATE or DELETE.
export type RejectTrigger = {
  readonly schema: string;
  readonly table: string;
  readonly functionName: string;
  readonly triggerName: string;
  readonly op: 'UPDATE' | 'DELETE';
  readonly message: string;
};

export type SqlMigration = {
  readonly schemaName: string;
  readonly headerComment: readonly string[];
  readonly enums: readonly SqlEnum[];
  readonly tables: readonly SqlTable[];
  readonly indexes: readonly SqlIndex[];
  readonly foreignKeys: readonly SqlForeignKey[];
  readonly lifecycleTrigger: LifecycleTrigger;
  readonly rejectTriggers: readonly RejectTrigger[];
};

// ---------------------------------------------------------------------------
// Comment-hygiene guard
// ---------------------------------------------------------------------------

/** A `--` comment line must not carry a `;` or a `$$` — the integration
 *  migration splitter is dollar-quote aware but not comment aware. Fail at
 *  generation, never ship the hazard. */
export function assertCommentSafe(line: string): string {
  if (line.includes(';') || line.includes('$$')) {
    throw new Error(
      `placement SQL generator: comment line contains a forbidden token (';' or '$$'): ${JSON.stringify(line)}`,
    );
  }
  return line;
}

function comment(lines: readonly string[]): string {
  // Empty lines emit a bare `--` (no trailing space) so the generated SQL
  // carries no trailing whitespace (git diff --check / CI whitespace wall).
  return lines.map((l) => (l === '' ? '--' : `-- ${assertCommentSafe(l)}`)).join('\n');
}

function q(schema: string, name: string): string {
  return `"${schema}"."${name}"`;
}

// ---------------------------------------------------------------------------
// Emitters — one per node kind; each returns a SQL fragment string.
// ---------------------------------------------------------------------------

function emitCreateSchema(schema: string): string {
  return `CREATE SCHEMA IF NOT EXISTS "${schema}";`;
}

function emitEnum(e: SqlEnum): string {
  const values = e.values.map((v) => `'${v}'`).join(', ');
  return `CREATE TYPE ${q(e.schema, e.name)} AS ENUM (${values});`;
}

function emitColumn(c: SqlColumn): string {
  const parts = [`"${c.name}"`, c.type, c.nullable ? 'NULL' : 'NOT NULL'];
  if (c.default !== undefined) parts.push(`DEFAULT ${c.default}`);
  return parts.join(' ');
}

function emitTable(t: SqlTable): string {
  const cols = t.columns.map((c) => `    ${emitColumn(c)}`);
  const pk = `    CONSTRAINT "${t.name}_pkey" PRIMARY KEY (${t.primaryKey.map((c) => `"${c}"`).join(', ')})`;
  // Columns comma-terminated, a blank line, then the PK constraint — the
  // Prisma-generated table style (submittal/CTR precedent). The PK carries no
  // trailing comma.
  const body = `${cols.join(',\n')},\n\n${pk}`;
  return `${comment(t.comment)}\nCREATE TABLE ${q(t.schema, t.name)} (\n${body}\n);`;
}

function emitIndex(i: SqlIndex): string {
  const cols = i.columns.map((c) => `"${c}"`).join(', ');
  return `CREATE INDEX "${i.name}" ON ${q(i.schema, i.table)}(${cols});`;
}

function emitForeignKey(fk: SqlForeignKey): string {
  return (
    `ALTER TABLE ${q(fk.schema, fk.table)} ADD CONSTRAINT "${fk.name}" ` +
    `FOREIGN KEY ("${fk.column}") REFERENCES ${q(fk.refSchema, fk.refTable)}("${fk.refColumn}") ` +
    `ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate};`
  );
}

/** Pin every immutable column byte-identical OLD-vs-NEW. All placement
 *  columns are NOT NULL, so equality (`=`) is correct throughout; a nullable
 *  column would need `IS NOT DISTINCT FROM` (submittal precedent). */
function emitPins(immutableColumns: readonly string[]): string {
  return immutableColumns.map((c) => `      AND OLD.${c} = NEW.${c}`).join('\n');
}

function emitTransitionBranch(b: TransitionBranch, t: LifecycleTrigger): string {
  return (
    `  IF (OLD.${t.stateColumn} = '${b.from}' AND NEW.${t.stateColumn} = '${b.to}'\n` +
    `${emitPins(t.immutableColumns)})\n` +
    `  THEN\n    RETURN NEW;\n  END IF;`
  );
}

function emitLifecycleTrigger(t: LifecycleTrigger): string {
  const notInList = t.duplicateGuardInactive.map((s) => `'${s}'`).join(', ');
  const keyPredicate = t.keyColumns
    .map((c) => `        AND existing.${c} = NEW.${c}`)
    .join('\n')
    .replace('        AND ', '        '); // first key column has no leading AND
  const branches = t.transitions.map((b) => emitTransitionBranch(b, t)).join('\n\n');

  const header = comment([
    '============================================================================',
    'PlacementProcess lifecycle guard — ONE trigger, TWO concerns (E1-a §5).',
    'GENERATED from the typed lifecycle registry (src/lib/lifecycle). Do NOT edit',
    'this SQL by hand -- CI regenerates it and asserts byte-equality (§5c). The',
    'two state classifications below DERIVE from lifecycle position (§4c) -- they',
    'are not authored as independent SQL literals.',
    '',
    'A. BEFORE INSERT -- at most one LIVE PlacementProcess per (tenant_id,',
    '   submittal_id). A row is live unless its state is DUPLICATE_GUARD_INACTIVE',
    '   (lifecycle position TERMINAL). STARTED is ENGAGED, not TERMINAL, so a',
    '   started placement still blocks a second attempt.',
    'B. BEFORE UPDATE -- only the state column may change, and only along the 14',
    '   legal edges. Every other column is pinned byte-identical. A transition',
    '   violation and a duplicate-live violation raise distinguishable messages.',
    'NOTE keep this comment block free of the statement terminator and the',
    'dollar-quote delimiter -- the integration migration splitter is dollar-quote',
    'aware but does not strip line comments.',
    '============================================================================',
  ]);

  return (
    `${header}\n` +
    `CREATE OR REPLACE FUNCTION ${t.schema}.${t.functionName}()\n` +
    `RETURNS TRIGGER AS $$\n` +
    `BEGIN\n` +
    `  -- Concern A -- BEFORE INSERT duplicate-live-attempt guard.\n` +
    `  IF (TG_OP = 'INSERT') THEN\n` +
    `    IF EXISTS (\n` +
    `      SELECT 1 FROM ${q(t.schema, t.table)} existing\n` +
    `      WHERE ${keyPredicate.trimStart()}\n` +
    `        AND existing.${t.stateColumn} NOT IN (${notInList})\n` +
    `    ) THEN\n` +
    `      RAISE EXCEPTION\n        '${t.duplicateViolationMessage}'\n        USING ERRCODE = 'check_violation';\n` +
    `    END IF;\n` +
    `    RETURN NEW;\n` +
    `  END IF;\n\n` +
    `  -- Concern B -- BEFORE UPDATE transition matrix + column-scoped immutability.\n` +
    `  IF (TG_OP = 'UPDATE') THEN\n` +
    `${branches}\n\n` +
    `    RAISE EXCEPTION\n      '${t.transitionViolationMessage}'\n      USING ERRCODE = 'check_violation';\n` +
    `  END IF;\n\n` +
    `  RETURN NEW;\n` +
    `END;\n` +
    `$$ LANGUAGE plpgsql;\n\n` +
    `CREATE TRIGGER ${t.triggerName}\n` +
    `  BEFORE INSERT OR UPDATE ON ${q(t.schema, t.table)}\n` +
    `  FOR EACH ROW EXECUTE FUNCTION ${t.schema}.${t.functionName}();`
  );
}

function emitRejectTrigger(r: RejectTrigger): string {
  return (
    `${comment([`${r.table} is append-only and absolutely immutable (§3) -- ${r.op} rejected at the database layer.`])}\n` +
    `CREATE OR REPLACE FUNCTION ${r.schema}.${r.functionName}()\n` +
    `RETURNS TRIGGER AS $$\n` +
    `BEGIN\n` +
    `  RAISE EXCEPTION\n    '${r.message}'\n    USING ERRCODE = 'check_violation';\n` +
    `END;\n` +
    `$$ LANGUAGE plpgsql;\n\n` +
    `CREATE TRIGGER ${r.triggerName}\n` +
    `  BEFORE ${r.op} ON ${q(r.schema, r.table)}\n` +
    `  FOR EACH ROW EXECUTE FUNCTION ${r.schema}.${r.functionName}();`
  );
}

// ---------------------------------------------------------------------------
// Top-level emitter — fixed section order, blank-line separated, trailing \n.
// ---------------------------------------------------------------------------

export function emitMigration(m: SqlMigration): string {
  const sections: string[] = [];
  sections.push(comment(m.headerComment));
  sections.push('-- CreateSchema\n' + emitCreateSchema(m.schemaName));
  for (const e of m.enums) sections.push('-- CreateEnum\n' + emitEnum(e));
  for (const t of m.tables) sections.push('-- CreateTable\n' + emitTable(t));
  for (const i of m.indexes) sections.push('-- CreateIndex\n' + emitIndex(i));
  for (const fk of m.foreignKeys) sections.push('-- AddForeignKey\n' + emitForeignKey(fk));
  sections.push(emitLifecycleTrigger(m.lifecycleTrigger));
  for (const r of m.rejectTriggers) sections.push(emitRejectTrigger(r));
  return sections.join('\n\n') + '\n';
}
