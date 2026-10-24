// PLATFORM-UX-1 F-9 (handoff §10.7 Compare) — the VersionDiff algorithm, exactly as the
// design file defines it (Template Studio.dc.html lcs / wordDiff / blockDiff):
//   - LCS over the blocks' plain text (variables as `{{key}}`);
//   - adjacent removed + added runs pair up as "changed" and are word-diffed (LCS over
//     whitespace-split tokens); the surplus stays removed / added.

export type DiffOp = readonly ['=' | '-' | '+', number | null, number | null];

export function lcs<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = d[i] as number[];
    const next = d[i + 1] as number[];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = eq(a[i] as T, b[j] as T) ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(a[i] as T, b[j] as T)) {
      ops.push(['=', i, j]);
      i++;
      j++;
    } else if ((d[i + 1]?.[j] ?? 0) >= (d[i]?.[j + 1] ?? 0)) {
      ops.push(['-', i, null]);
      i++;
    } else {
      ops.push(['+', null, j]);
      j++;
    }
  }
  while (i < n) ops.push(['-', i++, null]);
  while (j < m) ops.push(['+', null, j++]);
  return ops;
}

export type SegKind = 'same' | 'del' | 'add';
export interface DiffSeg {
  readonly t: string;
  readonly kind: SegKind;
  /** A `{{key}}` token (rendered in the mono face). */
  readonly isVar: boolean;
}

const seg = (t: string, kind: SegKind): DiffSeg => ({ t, kind, isVar: /^\{\{.+\}\}$/.test(t) });

/** Whitespace-preserving tokens ("a  b" → ["a", "  ", "b"]). */
export function tokens(s: string): string[] {
  return s.split(/(\s+)/).filter((x) => x.length > 0);
}

export function wordDiff(a: string, b: string): { L: DiffSeg[]; R: DiffSeg[] } {
  const A = tokens(a);
  const B = tokens(b);
  const L: DiffSeg[] = [];
  const R: DiffSeg[] = [];
  for (const [o, i, j] of lcs(A, B, (x, y) => x === y)) {
    if (o === '=') {
      L.push(seg(A[i as number] as string, 'same'));
      R.push(seg(B[j as number] as string, 'same'));
    } else if (o === '-') L.push(seg(A[i as number] as string, 'del'));
    else R.push(seg(B[j as number] as string, 'add'));
  }
  return { L, R };
}

export type RowKind = 'same' | 'add' | 'del' | 'chg';
export interface DiffBlock {
  readonly kind: string; // block kind (p · h2 · ul · ol)
  readonly text: string; // plain text, variables as {{key}}
}
export interface DiffRowModel {
  readonly kind: RowKind;
  readonly L: DiffSeg[];
  readonly R: DiffSeg[];
  /** The left / right block kinds ('' on the empty side). */
  readonly lt: string;
  readonly rt: string;
}

export function blockDiff(A: readonly DiffBlock[], B: readonly DiffBlock[]): DiffRowModel[] {
  const a = A.map((x) => x.text);
  const b = B.map((x) => x.text);
  const ops = lcs(a, b, (x, y) => x === y);
  const rows: DiffRowModel[] = [];
  let k = 0;
  while (k < ops.length) {
    const op = ops[k] as DiffOp;
    if (op[0] === '=') {
      const i = op[1] as number;
      const s = tokens(a[i] as string).map((x) => seg(x, 'same'));
      rows.push({ kind: 'same', L: s, R: s, lt: (A[i] as DiffBlock).kind, rt: (B[op[2] as number] as DiffBlock).kind });
      k++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (k < ops.length && (ops[k] as DiffOp)[0] !== '=') {
      const o = ops[k] as DiffOp;
      if (o[0] === '-') dels.push(o[1] as number);
      else adds.push(o[2] as number);
      k++;
    }
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const di = dels[i];
      const ai = adds[i];
      if (di !== undefined && ai !== undefined) {
        const { L, R } = wordDiff(a[di] as string, b[ai] as string);
        rows.push({ kind: 'chg', L, R, lt: (A[di] as DiffBlock).kind, rt: (B[ai] as DiffBlock).kind });
      } else if (di !== undefined) {
        rows.push({ kind: 'del', L: tokens(a[di] as string).map((x) => seg(x, 'del')), R: [], lt: (A[di] as DiffBlock).kind, rt: '' });
      } else if (ai !== undefined) {
        rows.push({ kind: 'add', L: [], R: tokens(b[ai] as string).map((x) => seg(x, 'add')), lt: '', rt: (B[ai] as DiffBlock).kind });
      }
    }
  }
  return rows;
}

export interface DiffStats {
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly unchanged: number;
}

export function diffStats(rows: readonly DiffRowModel[]): DiffStats {
  return {
    added: rows.filter((r) => r.kind === 'add').length,
    changed: rows.filter((r) => r.kind === 'chg').length,
    removed: rows.filter((r) => r.kind === 'del').length,
    unchanged: rows.filter((r) => r.kind === 'same').length,
  };
}
