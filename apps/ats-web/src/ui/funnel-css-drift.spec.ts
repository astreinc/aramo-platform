import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FUNNEL_BUCKETS } from './stage-map';

// L3-G — funnel CSS drift/exclusivity guard. The recruiter ribbon + talent-card stage
// pills render one class per canonical FUNNEL_BUCKETS key (stage-map.ts, itself the only
// projection of the 7-state Pipeline). This guard pins the ui.css class SET to exactly the
// bucket keys, in BOTH directions:
//   - every bucket key has a class (no unstyled bucket), and
//   - no stale/unmapped class survives (the dead `--submitted`/`--placed`/`--interview`/
//     `--offer`/`--sourced` classes that #732 removed can never silently reappear).
// This is the drift guard whose absence let the dead 6-bucket classes rot undetected.

// cwd-robust: nx may run vitest from the workspace root or the project root.
const CSS_PATH = [
  resolve(process.cwd(), 'apps/ats-web/src/ui/ui.css'),
  resolve(process.cwd(), 'src/ui/ui.css'),
].find(existsSync);
if (CSS_PATH === undefined) throw new Error(`ui.css not found from cwd ${process.cwd()}`);
const css = readFileSync(CSS_PATH, 'utf8');
const BUCKET_KEYS = [...FUNNEL_BUCKETS.map((b) => b.key)].sort();

function definedSuffixes(family: string): string[] {
  const re = new RegExp(`\\.${family}--([a-z_]+)`, 'g');
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) out.add(m[1]!);
  return [...out].sort();
}

describe('funnel CSS drift guard (L3-G)', () => {
  for (const family of ['rc-tcard__stage', 'rc-distseg']) {
    it(`${family}-- classes are EXACTLY the canonical FUNNEL_BUCKETS keys (no stale, no unmapped)`, () => {
      expect(definedSuffixes(family)).toEqual(BUCKET_KEYS);
    });
  }
});
