import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// L2-I (D1) — AC-1 (SB-7, structural): a provider observation reaches Pipeline ONLY via the
// governed apps/api command seam. The connector/integration libs hold NO Pipeline mutation
// surface: `libs/integration` and `libs/job-distribution` must contain ZERO `@aramo/pipeline`
// import and ZERO `PipelineRepository` reference. The mapping seam stores bounded Strings only;
// the canonical vocabulary + the governed command live in apps/api (which legitimately knows
// @aramo/pipeline). If a future edit injects the Pipeline command/repo into a connector lib,
// this control goes red.
const ROOT = resolve(__dirname, '../../../..');

function grepCount(pattern: string, dir: string): number {
  try {
    const out = execSync(
      `grep -rEl ${JSON.stringify(pattern)} ${JSON.stringify(resolve(ROOT, dir))} --include=${JSON.stringify('*.ts')} || true`,
      { encoding: 'utf8' },
    );
    return out.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

describe('L2-I D1 AC-1 — connector⊥Pipeline seam (SB-7 structural)', () => {
  it('libs/integration has NO @aramo/pipeline import and NO PipelineRepository reference', () => {
    expect(grepCount("from '@aramo/pipeline'", 'libs/integration/src')).toBe(0);
    expect(grepCount('PipelineRepository', 'libs/integration/src')).toBe(0);
  });

  it('libs/job-distribution has NO @aramo/pipeline import and NO PipelineRepository reference', () => {
    expect(grepCount("from '@aramo/pipeline'", 'libs/job-distribution/src')).toBe(0);
    expect(grepCount('PipelineRepository', 'libs/job-distribution/src')).toBe(0);
  });

  it('the Pipeline mapping repository itself imports NOTHING from @aramo/pipeline (bounded Strings only)', () => {
    // The import FORM (not a bare mention — the header comment names the wall it honors).
    expect(grepCount("from '@aramo/pipeline'", 'libs/integration/src/lib/lifecycle/pipeline-disposition-mapping.repository.ts')).toBe(0);
    expect(grepCount('import.*@aramo/pipeline', 'libs/integration/src/lib/lifecycle/pipeline-disposition-mapping.repository.ts')).toBe(0);
  });
});
