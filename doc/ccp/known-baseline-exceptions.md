# CCP program branch: known baseline exceptions

These are failures seen on the integrated branch (`feat/ccp-commercial-control-plane`) whose cause sits outside the merge being validated. Each entry gives its evidence and status. An entry is **not** a green gate. It is a recorded, investigated exception.

## 1. Two platform-web e2e lint errors (TD-C4-21): FIXED at the C4 merge

Both errors are lint-only. They sit in the Playwright fixtures/visual sources, which no unit target lints. CCP-B1 introduced both (`d1a90eb9`), and both reproduce on `wip/ccp-b1`.

They also reproduce at `41a0e3b5`. Repro: `git show 41a0e3b5:<file> | npx eslint --stdin --stdin-filename <file>`.

| File:line at `41a0e3b5` | Rule | Message | Fix (behaviour-neutral) |
|---|---|---|---|
| `apps/platform-web/e2e/fixtures/commercial.ts:253:11` | `@typescript-eslint/no-this-alias` | Unexpected aliasing of 'this' to local variable (`const w = this;` in `CcpWorld.mock()`) | Removed the alias. Every closure inside `mock()` is an arrow function, so `this` is lexical. Each `w.` became `this.`; nothing else changed. |
| `apps/platform-web/e2e/visual/states-ccp.ts:9:1` | `import-x/order` | There should be at least one empty line between import groups | One blank line inserted between the parent-directory and sibling import groups (`eslint --fix`). |

After the fix, both files lint with 0 errors. Five pre-existing warnings remain: 4 `no-non-null-assertion` and 1 `no-unused-vars` on R3's `_omitted` rest binding. `tsc -p apps/platform-web/e2e/tsconfig.json` is clean.

## 2. Template Studio visual failures (PLATFORM-UX-1 baselines): OPEN, not CCP-caused

| Test | Viewport | Diff | Pattern |
|---|---|---|---|
| `studio-preview-zoom` | 900 | 61 px | glyph edges only |
| `studio-compare-changes` | 1440 | 66 px | glyph edges only |

- **Recurrence:** both fail on every attempt, at every integrated head where the visual project ran in this program (merge train 1 through train 2).
- **Not CCP code:** `git diff origin/main...41a0e3b5` shows no change under `apps/platform-web/src/document-templates`, `libs/document-templates-web` or `libs/fe-foundation`. The CCP program does not touch the Template Studio sources.
- **Diagnosis:** the differing pixels are anti-aliased glyph edges. That is consistent with font rasterisation on this host differing from the host that captured the PLATFORM-UX-1 baselines.
- **Status:** the baselines are **not** re-captured (standing instruction: do not re-capture PLATFORM-UX-1 baselines). Owner: PLATFORM-UX-1 / platform-web. Re-check on the CI runner before any baseline action.

## 3. Template Studio `studio-preview-zoom @900`, `studio-compare-changes @1440`, `studio-properties @900` at the final gate: OPEN, not CCP-caused

At the final integrated gate (`105b382e`, `doc/ccp/program-gate-final.md` §7), each state was re-run alone, serially, with no retry:
- `studio-preview-zoom @900`: 61 px, failed both attempts;
- `studio-compare-changes @1440`: 66 px, failed both attempts;
- `studio-properties @900`: 39 px, failed 1 attempt in 8, then passed 7.

All three are glyph edges only. `git diff origin/main...HEAD` is still empty for the Template Studio sources (§2). Not re-captured; not called green. Owner: PLATFORM-UX-1 / platform-web.
