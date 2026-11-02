import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Aramo Sign Feature-Parity 1.1 — templates (Feature-Parity Program Directive v1.0 LOCKED §1.1;
// PO locked model 2026-11-01): templates are authored ONLY at the platform level and adopted,
// edited and approved by the tenant in the shared Template Studio (Org Home). Aramo Sign never
// creates, edits, deletes or stores a template. This guard stops drift:
//   1. no sign-service controller route touches a template path other than the three
//      DOC-TEMPLATE-LIB-1 T-5 "use" routes (list, preview, start an envelope) and the
//      TEMPLATE-PRODUCT-1 §8 Documents pass-throughs listed below;
//   2. no Template model in the Sign schema (the M-A6 provenance columns template_ref /
//      template_version_ref on SignatureEnvelope are opaque references, not a model).
// The routes are read from the controller sources (every @Controller base joined with each
// handler's @Get/@Post/@Put/@Patch/@Delete/@All path), so a new controller file is covered.

const APP = resolve(__dirname, '../app');
const SIGN_SCHEMA = resolve(__dirname, '../../../../libs/sign/prisma/schema.prisma');

const USE_ROUTES = ['GET v1/sign/sender/templates', 'POST v1/sign/sender/templates/:id/preview', 'POST v1/sign/sender/envelopes/from-template'];
// Aramo-TEMPLATE-PRODUCT-1 Implementation Directive v1.0 (LOCKED) §8 + §10 (supersedes Feature-Parity
// A2 :10/:11 as the governing target): for a PERSONAL account Sign hosts the shared Studio, and
// every account gets the gallery and "Use as it is". These routes are pass-throughs to Documents
// over the signed S2S channel — Documents owns every row; Sign still stores nothing (the schema
// check below is unchanged). Business authoring stays in Org Home (the Studio routes refuse it).
const TEMPLATE_PRODUCT_1_ROUTES = [
  'GET v1/sign/sender/templates/library',
  'GET v1/sign/sender/templates/library/:id/preview',
  'POST v1/sign/sender/templates/library/:id/adopt-and-use',
  'GET v1/sign/sender/templates/studio',
  'POST v1/sign/sender/templates/studio/adopt',
  'GET v1/sign/sender/templates/studio/:id',
  'PATCH v1/sign/sender/templates/studio/:id',
  'GET v1/sign/sender/templates/studio/:id/versions',
  'POST v1/sign/sender/templates/studio/:id/versions',
  'POST v1/sign/sender/templates/studio/:id/draft',
  'GET v1/sign/sender/templates/studio/:id/allowed-bindings',
  'PATCH v1/sign/sender/templates/studio/versions/:versionId',
  'DELETE v1/sign/sender/templates/studio/versions/:versionId',
  'POST v1/sign/sender/templates/studio/versions/:versionId/preview',
  'POST v1/sign/sender/templates/studio/versions/:versionId/activate',
];
const ALLOWED = new Set([...USE_ROUTES, ...TEMPLATE_PRODUCT_1_ROUTES]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

function joinPath(a: string, b: string): string {
  return [a, b].map((x) => x.replace(/^\/+|\/+$/g, '')).filter((x) => x.length > 0).join('/');
}

const DECORATOR = /@(Controller|Get|Post|Put|Patch|Delete|All)\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)?[^)]*\)/g;

function routes(): Array<{ route: string; file: string }> {
  const out: Array<{ route: string; file: string }> = [];
  for (const file of sourceFiles(APP)) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('@Controller')) continue;
    let base = '';
    for (const m of src.matchAll(DECORATOR)) {
      const path = m[2] ?? m[3] ?? m[4] ?? '';
      if (m[1] === 'Controller') base = path;
      else out.push({ route: `${(m[1] as string).toUpperCase()} ${joinPath(base, path)}`, file: relative(APP, file) });
    }
  }
  return out;
}

describe('Sign never authors templates (PO locked model: platform defaults, adopted in Org Home)', () => {
  it('the only template routes on sign-service are the use routes and the TEMPLATE-PRODUCT-1 §8 Documents pass-throughs', () => {
    const all = routes();
    // The scan itself must see the sender surface, or it proves nothing.
    expect(all.map((r) => r.route)).toContain('POST v1/sign/sender/envelopes/:id/send');
    const templateRoutes = all.filter((r) => /templat/i.test(r.route));
    expect(templateRoutes.filter((r) => !ALLOWED.has(r.route))).toEqual([]);
    expect(new Set(templateRoutes.map((r) => r.route))).toEqual(ALLOWED);
  });

  it('the Sign schema has no Template model', () => {
    const models = [...readFileSync(SIGN_SCHEMA, 'utf8').matchAll(/^model\s+(\w+)/gm)].map((m) => m[1] as string);
    expect(models.length).toBeGreaterThan(0);
    expect(models.filter((m) => /templat/i.test(m))).toEqual([]);
  });
});
