import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Guard: a controller parameter's emitted runtime type must never be a NestJS
// parameter DECORATOR function.
//
// Production compiles with tsc + `emitDecoratorMetadata`. When a handler declares
// `@Body() body: Body` and a local `type Body = …` shadows the type name, tsc emits
// `design:paramtypes` = the imported `@nestjs/common` `Body` decorator FUNCTION
// (type aliases have no runtime value, so the emitter falls back to the value of
// the same name). The global ValidationPipe (whitelist + forbidNonWhitelisted)
// then validates the request against that "class" — which declares no fields — and
// rejects EVERY property ("property x should not exist"). This shipped in the
// Technical Screening controller (13 endpoints: findings, notes, edits all 400).
//
// The repo's Vitest transformer (esbuild) emits NO decorator metadata, so
// HTTP-level specs skip validation and cannot see this class of defect. This guard
// therefore reproduces the PRODUCTION emit: it compiles each controller with the
// TypeScript emitter and the same decorator options, and inspects what is emitted.

const ROOT = resolve(__dirname, '../../../..');
const NEST_PARAM_DECORATORS = [
  'Body', 'Query', 'Param', 'Headers', 'Req', 'Request', 'Res', 'Response',
  'Ip', 'Session', 'HostParam', 'UploadedFile', 'UploadedFiles', 'Next',
];

function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'generated') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) controllerFiles(p, out);
    else if (name.endsWith('.controller.ts')) out.push(p);
  }
  return out;
}

// Emit the file the way production does (decorators + metadata), transpile-only:
// a type-alias reference is emitted as the runtime value of the same NAME, exactly
// as tsc does for the real build.
function emittedParamTypes(source: string, fileName: string): string[] {
  const out = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    },
  }).outputText;
  return [...out.matchAll(/__metadata\("design:paramtypes", \[([\s\S]*?)\]\)/g)].map((m) => m[1] ?? '');
}

function offenders(file: string): string[] {
  const found: string[] = [];
  for (const params of emittedParamTypes(readFileSync(file, 'utf8'), file)) {
    for (const d of NEST_PARAM_DECORATORS) {
      // e.g. `typeof (_a = typeof common_1.Body !== "undefined" && common_1.Body) === "function" ? _a : Object`
      if (new RegExp(`\\b[A-Za-z_$][\\w$]*\\.${d}\\b`).test(params)) found.push(d);
    }
  }
  return [...new Set(found)];
}

describe('decorator metadata — no parameter type resolves to a NestJS param decorator', () => {
  const files = [...controllerFiles(join(ROOT, 'apps')), ...controllerFiles(join(ROOT, 'libs'))];

  it('scans a non-trivial controller set (guards against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('detector self-test: a shadowing `type Body` IS caught (the shipped defect shape)', () => {
    const fixture = [
      "import { Body, Controller, Post } from '@nestjs/common';",
      'type Body = Record<string, unknown> | undefined;',
      "@Controller('x') export class X { @Post() a(@Body() body: Body) { return body; } }",
    ].join('\n');
    const params = emittedParamTypes(fixture, 'fixture.controller.ts').join(' ');
    expect(params).toMatch(/\.Body\b/);
  });

  it('detector self-test: a correctly named alias is NOT flagged', () => {
    const fixture = [
      "import { Body, Controller, Post } from '@nestjs/common';",
      'type RequestBody = Record<string, unknown> | undefined;',
      "@Controller('x') export class X { @Post() a(@Body() body: RequestBody) { return body; } }",
    ].join('\n');
    const params = emittedParamTypes(fixture, 'fixture.controller.ts').join(' ');
    expect(params).not.toMatch(/\.Body\b/);
  });

  it('no controller in apps/ or libs/ emits a NestJS decorator as a parameter type', () => {
    const bad = files
      .map((f) => ({ file: relative(ROOT, f), decorators: offenders(f) }))
      .filter((r) => r.decorators.length > 0);
    expect(bad).toEqual([]);
  });
});
