import { LIST_MAX_DEPTH_V2, PAGE_BREAK_ATTR, PAGE_BREAK_VALUE, TABLE_MAX_COLUMNS, TABLE_MAX_ROWS } from '@aramo/template-content';

import { parseSanitized, serialize, type HtmlNode } from '../../rtr/rtr-html-content.js';

import type { WordImportWarning, WordImportWarningCode } from './word-import.constants.js';

// TEMPLATE-IMPORT-1 W-3 — mammoth's HTML for a Word document → rtr-html-v2 content. PURE: no
// I/O, no mammoth; the kinds and limits come from @aramo/template-content. The output is only
// a proposal: the server normaliser (sanitiser, known `{{key}}` → chip, size cap) still runs
// on it exactly as on a hand-built draft (W-6).
//
// mammoth is driven by docx-to-content.ts with this style map, which the mapper relies on:
//   p[style-name='Title'] => p.aramo-title:fresh   (the document title)
//   br[type='page']       => hr.aramo-page-break   (a manual page break; may sit inside a p)
//   u                     => u                     (mammoth drops underline by default)
// Word headings arrive as h1…h6, header rows as thead/th, merged cells as colspan/rowspan,
// notes as `<sup><a href="#footnote-N">` references plus a trailing `<ol>` of `<li id="footnote-N">`,
// images as `<img>` (with no data: docx-to-content.ts never reads image bytes).

export const TITLE_CLASS = 'aramo-title';
export const PAGE_BREAK_CLASS = 'aramo-page-break';

export interface WordContent {
  /** The document title: a leading Title-style paragraph, else null (the caller uses the file name). */
  readonly title: string | null;
  /** Canonical rtr-html-v2 html (top-level blocks only). */
  readonly html: string;
  readonly warnings: readonly WordImportWarning[];
}

type El = HtmlNode & { type: 'el' };
const el = (tag: string, children: HtmlNode[] = [], attrs: Record<string, string> = {}): El => ({ type: 'el', tag, attrs, children });
const text = (t: string): HtmlNode => ({ type: 'text', text: t });
// Narrows to an element with that tag (a false result leaves other elements possible).
function isEl<T extends string = string>(n: HtmlNode | undefined, tag?: T): n is El & { tag: T } {
  return n !== undefined && n.type === 'el' && (tag === undefined || n.tag === tag);
}
const classes = (n: El): string[] => (n.attrs['class'] ?? '').split(/\s+/).filter((c) => c !== '');
const isPageBreak = (n: HtmlNode): boolean => isEl(n, 'hr') && classes(n).includes(PAGE_BREAK_CLASS);
const NOTE_ID = /^(footnote|endnote)-/;
const NOTE_HREF = /^#(footnote|endnote)-/;

const HEADING: Record<string, 'h2' | 'h3' | 'h4'> = { h1: 'h2', h2: 'h3', h3: 'h4', h4: 'h4', h5: 'h4', h6: 'h4' };
const MARKS: Record<string, string> = { strong: 'b', b: 'b', em: 'i', i: 'i', u: 'u' };
const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'div', 'blockquote', 'dl']);

/** Plain text of nodes (whitespace collapsed). */
export function plainText(nodes: readonly HtmlNode[]): string {
  let s = '';
  const walk = (ns: readonly HtmlNode[]): void => {
    for (const n of ns) {
      if (n.type === 'text') s += n.text;
      else if (n.tag === 'br') s += ' ';
      else {
        walk(n.children);
        if (BLOCKS.has(n.tag) || n.tag === 'li' || n.tag === 'td' || n.tag === 'th') s += ' ';
      }
    }
  };
  walk(nodes);
  return s.replace(/\s+/g, ' ').trim();
}

function snippet(s: string): string | undefined {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t === '') return undefined;
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}

class Warnings {
  private readonly m = new Map<WordImportWarningCode, { count: number; example?: string }>();
  add(code: WordImportWarningCode, n = 1, example?: string): void {
    if (n <= 0) return;
    const cur = this.m.get(code) ?? { count: 0 };
    const ex = cur.example ?? (example !== undefined ? snippet(example) : undefined);
    this.m.set(code, { count: cur.count + n, ...(ex !== undefined ? { example: ex } : {}) });
  }
  list(): WordImportWarning[] {
    return [...this.m.entries()].map(([code, v]) => ({ code, count: v.count, ...(v.example !== undefined ? { example: v.example } : {}) }));
  }
}

/** True when inline nodes hold any text (a mark around only spaces or a lone line break is empty). */
function hasContent(nodes: readonly HtmlNode[]): boolean {
  return nodes.some((n) => (n.type === 'text' ? n.text.trim() !== '' : n.tag !== 'br' && hasContent(n.children)));
}

// Trim a block's edges: leading / trailing line breaks and the spaces at its two ends.
function trimBr(nodes: HtmlNode[]): HtmlNode[] {
  let a = 0;
  let b = nodes.length;
  while (a < b && isEl(nodes[a], 'br')) a++;
  while (b > a && isEl(nodes[b - 1], 'br')) b--;
  const out = nodes.slice(a, b);
  const edge = (n: HtmlNode | undefined, side: 'start' | 'end'): HtmlNode | undefined => {
    if (n === undefined) return n;
    if (n.type === 'text') return text(side === 'start' ? n.text.replace(/^\s+/, '') : n.text.replace(/\s+$/, ''));
    if (n.tag === 'br' || n.children.length === 0) return n;
    const kids = [...n.children];
    const i = side === 'start' ? 0 : kids.length - 1;
    kids[i] = edge(kids[i], side) as HtmlNode;
    return { ...n, children: kids };
  };
  if (out.length > 0) {
    out[0] = edge(out[0], 'start') as HtmlNode;
    out[out.length - 1] = edge(out[out.length - 1], 'end') as HtmlNode;
  }
  return out.filter((n) => n.type !== 'text' || n.text !== '');
}

/**
 * Map one Word document's mammoth HTML. `extraWarnings` carries the counts found on the
 * package itself (text boxes, comments, headers / footers), so all warnings are in one list.
 */
export function mapWordHtml(html: string, extraWarnings: readonly WordImportWarning[] = []): WordContent {
  const w = new Warnings();
  for (const x of extraWarnings) w.add(x.code, x.count, x.example);

  // ── inline content: marks kept, links unwrapped, notes and images dropped ──
  const inline = (nodes: readonly HtmlNode[]): HtmlNode[] => {
    const out: HtmlNode[] = [];
    for (const n of nodes) {
      if (n.type === 'text') {
        out.push(text(n.text.replace(/\u00a0/g, ' ')));
        continue;
      }
      if (n.tag === 'br') {
        out.push(el('br'));
        continue;
      }
      if (n.tag === 'img') {
        w.add('image_dropped', 1, n.attrs['alt']);
        continue;
      }
      if (n.tag === 'hr') continue; // page breaks are split out by the block mapper
      if (n.tag === 'sup' && n.children.some((c) => isEl(c, 'a') && NOTE_HREF.test(c.attrs['href'] ?? ''))) continue;
      if (n.tag === 'a' && NOTE_HREF.test(n.attrs['href'] ?? '')) continue;
      const mark = MARKS[n.tag];
      const kids = inline(n.children);
      if (mark !== undefined) {
        if (kids.length > 0) out.push(el(mark, kids));
      } else {
        out.push(...kids); // a, span, s, sub, sup and anything else: keep the text
      }
    }
    return out;
  };

  // Split a block's children at page breaks: [segment, break, segment, …].
  const splitAtBreaks = (nodes: readonly HtmlNode[]): Array<HtmlNode[] | 'break'> => {
    const parts: Array<HtmlNode[] | 'break'> = [[]];
    const walk = (ns: readonly HtmlNode[], wrap: (k: HtmlNode[]) => HtmlNode[]): void => {
      for (const n of ns) {
        if (isPageBreak(n)) {
          parts.push('break', []);
          continue;
        }
        if (isEl(n) && n.children.some((c) => containsBreak(c))) {
          // A mark wrapping a page break: split it, re-wrapping each side.
          const inner = (k: HtmlNode[]) => wrap([el(n.tag, k, n.attrs)]);
          walk(n.children, inner);
          continue;
        }
        (parts[parts.length - 1] as HtmlNode[]).push(...wrap([n]));
      }
    };
    walk(nodes, (k) => k);
    return parts;
  };
  const containsBreak = (n: HtmlNode): boolean => isPageBreak(n) || (isEl(n) && n.children.some(containsBreak));

  const blocks: El[] = [];
  const pushBreak = (): void => {
    const last = blocks[blocks.length - 1];
    if (last !== undefined && !(isEl(last, 'hr') && last.attrs[PAGE_BREAK_ATTR] === PAGE_BREAK_VALUE)) {
      blocks.push(el('hr', [], { [PAGE_BREAK_ATTR]: PAGE_BREAK_VALUE }));
    }
  };
  const pushText = (tag: string, nodes: readonly HtmlNode[]): void => {
    for (const part of splitAtBreaks(nodes)) {
      if (part === 'break') {
        pushBreak();
        continue;
      }
      const kids = trimBr(inline(part));
      if (hasContent(kids)) blocks.push(el(tag, kids));
    }
  };

  // ── lists: two levels kept, deeper items lifted into level 2 ──
  interface Item {
    inline: HtmlNode[];
    sub: { tag: string; items: Item[] } | null;
  }
  const readList = (list: El, depth: number): Item[] => {
    const items: Item[] = [];
    for (const li of list.children) {
      if (!isEl(li, 'li')) continue;
      const own: HtmlNode[] = [];
      const nested: El[] = [];
      for (const c of li.children) {
        if (isEl(c, 'ul') || isEl(c, 'ol')) nested.push(c);
        else if (isEl(c, 'p')) own.push(...(own.length > 0 ? [el('br')] : []), ...c.children);
        else own.push(c);
      }
      const item: Item = { inline: trimBr(inline(own)), sub: null };
      items.push(item);
      for (const n of nested) {
        if (depth < LIST_MAX_DEPTH_V2) {
          const subItems = readList(n, depth + 1);
          if (subItems.length > 0) {
            if (item.sub === null) item.sub = { tag: n.tag, items: subItems };
            else item.sub.items.push(...subItems);
          }
        } else {
          // Too deep: lift the items (and anything under them) to this level, after this item.
          const lifted = readList(n, depth);
          w.add('list_level_lifted', lifted.length, plainText(lifted[0]?.inline ?? []));
          items.push(...lifted);
        }
      }
    }
    return items;
  };
  const writeList = (tag: string, items: readonly Item[]): El =>
    el(
      tag,
      items.map((i) => el('li', [...i.inline, ...(i.sub !== null ? [writeList(i.sub.tag, i.sub.items)] : [])])),
    );

  // ── tables: merged cells split, header row kept, wide tables flattened, long ones split ──
  const cellInline = (nodes: readonly HtmlNode[]): HtmlNode[] => {
    const lines: HtmlNode[][] = [];
    const add = (k: HtmlNode[]): void => {
      const t = trimBr(k);
      if (hasContent(t)) lines.push(t);
    };
    const pending: HtmlNode[] = [];
    const flush = (): void => {
      if (pending.length > 0) add(inline(pending.splice(0)));
    };
    for (const n of nodes) {
      if (isEl(n) && (n.tag === 'p' || HEADING[n.tag] !== undefined)) {
        flush();
        add(inline(n.children));
      } else if (isEl(n) && (n.tag === 'ul' || n.tag === 'ol')) {
        flush();
        const walk = (l: El): void => {
          for (const li of l.children) {
            if (!isEl(li, 'li')) continue;
            add(inline(li.children.filter((c) => !isEl(c, 'ul') && !isEl(c, 'ol'))));
            li.children.filter((c): c is El => isEl(c, 'ul') || isEl(c, 'ol')).forEach(walk);
          }
        };
        walk(n);
      } else if (isEl(n, 'table')) {
        flush();
        const t = plainText([n]);
        if (t !== '') lines.push([text(t)]);
      } else pending.push(n);
    }
    flush();
    return lines.flatMap((l, i) => (i === 0 ? l : [el('br'), ...l]));
  };

  const mapTable = (table: El): void => {
    interface Src {
      readonly cells: El[];
      readonly head: boolean;
    }
    const rows: Src[] = [];
    const collect = (ns: readonly HtmlNode[], head: boolean): void => {
      for (const n of ns) {
        if (isEl(n, 'thead')) collect(n.children, true);
        else if (isEl(n, 'tbody') || isEl(n, 'tfoot')) collect(n.children, false);
        else if (isEl(n, 'tr')) rows.push({ cells: n.children.filter((c): c is El => isEl(c, 'td') || isEl(c, 'th')), head });
      }
    };
    collect(table.children, false);
    if (rows.length === 0) return;
    // Expand merged cells into a grid: the text stays in the first cell, the rest are empty.
    const pendingRows = new Map<number, number>(); // column → rows still covered by a rowspan
    let merged = 0;
    let mergedExample: string | undefined;
    const grid: Array<{ cells: Array<{ kids: HtmlNode[]; th: boolean }>; head: boolean }> = [];
    for (const r of rows) {
      const out: Array<{ kids: HtmlNode[]; th: boolean }> = [];
      const fillCovered = (): void => {
        for (let c = out.length; (pendingRows.get(c) ?? 0) > 0; c = out.length) {
          pendingRows.set(c, (pendingRows.get(c) ?? 0) - 1);
          out.push({ kids: [], th: false });
        }
      };
      for (const cell of r.cells) {
        fillCovered();
        const col = out.length;
        const colspan = Math.max(1, Number.parseInt(cell.attrs['colspan'] ?? '1', 10) || 1);
        const rowspan = Math.max(1, Number.parseInt(cell.attrs['rowspan'] ?? '1', 10) || 1);
        const kids = cellInline(cell.children);
        out.push({ kids, th: cell.tag === 'th' });
        for (let k = 1; k < colspan; k++) out.push({ kids: [], th: cell.tag === 'th' });
        if (colspan > 1 || rowspan > 1) {
          merged += 1;
          mergedExample ??= plainText(kids);
          if (rowspan > 1) for (let k = 0; k < colspan; k++) pendingRows.set(col + k, rowspan - 1);
        }
      }
      fillCovered();
      // Columns still covered beyond the last source cell.
      const maxCovered = Math.max(-1, ...[...pendingRows.entries()].filter(([, v]) => v > 0).map(([c]) => c));
      while (out.length <= maxCovered) {
        const c = out.length;
        if ((pendingRows.get(c) ?? 0) > 0) pendingRows.set(c, (pendingRows.get(c) ?? 0) - 1);
        out.push({ kids: [], th: false });
      }
      grid.push({ cells: out, head: r.head });
    }
    if (merged > 0) w.add('table_cells_unmerged', merged, mergedExample);
    const width = Math.max(...grid.map((g) => g.cells.length));
    if (width === 0) return;
    const first = grid[0] as (typeof grid)[number];
    const header = first.head || (first.cells.length > 0 && first.cells.every((c) => c.th));
    const firstText = first.cells.map((c) => plainText(c.kids)).filter((t) => t !== '').join(' ');

    if (width > TABLE_MAX_COLUMNS) {
      // Too wide for a page: one paragraph per row, cells joined by " · ".
      w.add('table_flattened', 1, firstText);
      for (const g of grid) {
        const parts = g.cells.filter((c) => hasContent(c.kids)).map((c) => c.kids);
        if (parts.length > 0) blocks.push(el('p', parts.flatMap((k, i) => (i === 0 ? k : [text(' · '), ...k]))));
      }
      return;
    }
    const tr = (cells: ReadonlyArray<{ kids: HtmlNode[] }>, th: boolean): El =>
      el('tr', Array.from({ length: width }, (_x, i) => el(th ? 'th' : 'td', cells[i]?.kids ?? [])));
    const headRow = header ? tr(first.cells, true) : null;
    const body = (header ? grid.slice(1) : grid).map((g) => tr(g.cells, false));
    const per = TABLE_MAX_ROWS - (headRow !== null ? 1 : 0);
    if (body.length > per) w.add('table_split', 1, firstText);
    if (body.length === 0 && headRow !== null) {
      blocks.push(el('table', [headRow]));
      return;
    }
    for (let i = 0; i < body.length; i += per) {
      blocks.push(el('table', [...(headRow !== null ? [headRow] : []), ...body.slice(i, i + per)]));
    }
  };

  // ── top level ──
  let title: string | null = null;
  const walkTop = (nodes: readonly HtmlNode[]): void => {
    for (const n of nodes) {
      if (n.type === 'text') {
        if (n.text.trim() !== '') pushText('p', [n]);
        continue;
      }
      if (isPageBreak(n)) {
        pushBreak();
        continue;
      }
      if (n.tag === 'p' && classes(n).includes(TITLE_CLASS) && title === null && blocks.length === 0) {
        const t = plainText(n.children);
        if (t !== '') {
          title = t;
          continue;
        }
      }
      const heading = HEADING[n.tag];
      if (heading !== undefined) {
        if (n.tag === 'h4' || n.tag === 'h5' || n.tag === 'h6') w.add('heading_level_merged', 1, plainText(n.children));
        pushText(heading, n.children);
        continue;
      }
      if (n.tag === 'p') {
        // A Title-style paragraph that is not the leading one reads as a section heading.
        pushText(classes(n).includes(TITLE_CLASS) ? 'h2' : 'p', n.children);
        continue;
      }
      if (n.tag === 'ul' || n.tag === 'ol') {
        const notes = n.children.filter((c) => isEl(c, 'li') && NOTE_ID.test(c.attrs['id'] ?? ''));
        if (notes.length > 0) {
          w.add('note_dropped', notes.length, plainText((notes[0] as El).children).replace(/\s*↑$/, ''));
          continue;
        }
        const items = readList(n, 1);
        if (items.some((i) => hasContent(i.inline) || i.sub !== null)) blocks.push(writeList(n.tag, items));
        continue;
      }
      if (n.tag === 'table') {
        mapTable(n);
        continue;
      }
      if (n.tag === 'dl') continue; // mammoth's comment list (comments are counted on the package)
      if (n.tag === 'img') {
        w.add('image_dropped', 1, n.attrs['alt']);
        continue;
      }
      if (BLOCKS.has(n.tag)) {
        walkTop(n.children);
        continue;
      }
      pushText('p', [n]);
    }
  };
  walkTop(parseSanitized(html));

  // No page break at the very start or end.
  while (isEl(blocks[0], 'hr')) blocks.shift();
  while (isEl(blocks[blocks.length - 1], 'hr')) blocks.pop();

  return { title, html: serialize(blocks), warnings: w.list() };
}

/** Counts of the top-level blocks of canonical content, for the import summary (W-7). */
export function blockCounts(html: string): Record<string, number> {
  const counts: Record<string, number> = { p: 0, h2: 0, h3: 0, h4: 0, ul: 0, ol: 0, table: 0, page_break: 0 };
  for (const n of parseSanitized(html)) {
    if (n.type !== 'el') continue;
    const k = n.tag === 'hr' ? (n.attrs[PAGE_BREAK_ATTR] === PAGE_BREAK_VALUE ? 'page_break' : 'hr') : n.tag;
    if (k in counts) counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}
