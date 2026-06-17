import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  TASK_OWNER_TYPE_VALUES,
  TASK_PRIORITY_VALUES,
  TASK_SOURCE_VALUES,
  TASK_STATUS_VALUES,
  TASK_TYPE_VALUES,
} from './types';

// Drift smoke spec (the legal-transitions-drift precedent; rule of three reached
// — type/priority/status/source are all guarded closed sets). The recruiter
// console hand-mirrors the BE task vocab (it cannot import @aramo/task — a
// forbidden domain edge). The BE files are the source of truth; this spec reads
// each as text, extracts the closed-set array, and asserts the FE mirror is
// IDENTICAL (order included). Any value added/removed/renamed in the BE fails
// here, forcing the FE vocab + labels/icons to be updated in lock-step.

const DTO_DIR = resolve(__dirname, '../../../../libs/task/src/lib/dto');

// Extract `export const <NAME> = [ '...', '...' ] as const;` from a BE source.
function parseValues(file: string, name: string): string[] {
  const source = readFileSync(resolve(DTO_DIR, file), 'utf8');
  const marker = `export const ${name} = [`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`drift: "${marker}" not found in ${file}`);
  const open = start + marker.length - 1; // index of '['
  const close = source.indexOf(']', open);
  const inner = source.slice(open + 1, close);
  return [...inner.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

describe('task vocab — FE mirror is identical to the BE closed sets', () => {
  it('TASK_TYPE_VALUES matches libs/task task-type.ts', () => {
    expect([...TASK_TYPE_VALUES]).toEqual(parseValues('task-type.ts', 'TASK_TYPE_VALUES'));
  });

  it('TASK_PRIORITY_VALUES matches libs/task task-priority.ts', () => {
    expect([...TASK_PRIORITY_VALUES]).toEqual(
      parseValues('task-priority.ts', 'TASK_PRIORITY_VALUES'),
    );
  });

  it('TASK_STATUS_VALUES matches libs/task task-status.ts', () => {
    expect([...TASK_STATUS_VALUES]).toEqual(parseValues('task-status.ts', 'TASK_STATUS_VALUES'));
  });

  it('TASK_SOURCE_VALUES matches libs/task task-source.ts', () => {
    expect([...TASK_SOURCE_VALUES]).toEqual(parseValues('task-source.ts', 'TASK_SOURCE_VALUES'));
  });

  it('TASK_OWNER_TYPE_VALUES matches libs/task task-owner-type.ts', () => {
    expect([...TASK_OWNER_TYPE_VALUES]).toEqual(
      parseValues('task-owner-type.ts', 'TASK_OWNER_TYPE_VALUES'),
    );
  });
});
