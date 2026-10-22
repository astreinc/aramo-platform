import { Fragment, type ReactNode } from 'react';

// A small, SAFE Markdown renderer for Aramo's own legal texts. It builds React
// elements only (no innerHTML): any HTML in the source shows as literal text.
// Supported — exactly what the legal texts use:
//   # / ## / ### headings · paragraphs · `---` rules · `> ` quotes
//   `- ` bullet lists (indented continuation lines join the item)
//   pipe tables (`| a | b |` + `|---|---|`; an all-empty header row is omitted)
//   inline **bold**, *italic*, `code`; bare https:// links (opened in a new tab)

type Block =
  | { k: 'h'; level: 1 | 2 | 3; text: string }
  | { k: 'p'; text: string }
  | { k: 'hr' }
  | { k: 'quote'; text: string }
  | { k: 'ul'; items: string[] }
  | { k: 'table'; head: string[] | null; rows: string[][] };

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSeparator = (l: string) => /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(l);
const cells = (l: string): string[] =>
  l
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h !== null) {
      out.push({ k: 'h', level: h[1]!.length as 1 | 2 | 3, text: h[2]!.trim() });
      i++;
      continue;
    }
    if (/^\s*-{3,}\s*$/.test(line)) {
      out.push({ k: 'hr' });
      i++;
      continue;
    }
    if (isTableRow(line)) {
      const rows: string[][] = [];
      let head: string[] | null = null;
      if (i + 1 < lines.length && isSeparator(lines[i + 1]!)) {
        const hc = cells(line);
        head = hc.some((c) => c !== '') ? hc : null;
        i += 2;
      }
      while (i < lines.length && isTableRow(lines[i]!)) {
        if (!isSeparator(lines[i]!)) rows.push(cells(lines[i]!));
        i++;
      }
      out.push({ k: 'table', head, rows });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const parts: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        parts.push(lines[i]!.replace(/^>\s?/, ''));
        i++;
      }
      out.push({ k: 'quote', text: parts.join(' ').trim() });
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        if (/^\s*-\s+/.test(l)) items.push(l.replace(/^\s*-\s+/, '').trim());
        else if (/^\s{2,}\S/.test(l) && items.length > 0) items[items.length - 1] += ` ${l.trim()}`;
        else break;
        i++;
      }
      out.push({ k: 'ul', items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.trim() === '' || /^(#{1,3})\s/.test(l) || /^\s*-{3,}\s*$/.test(l) || isTableRow(l) || /^>\s?/.test(l) || /^\s*-\s+/.test(l)) break;
      para.push(l.trim());
      i++;
    }
    out.push({ k: 'p', text: para.join(' ') });
  }
  return out;
}

/** Inline **bold**, *italic*, `code` and bare https:// links — as React nodes, never HTML. */
export function renderInline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let n = 0;
  const flush = () => {
    if (buf !== '') out.push(...linkify(buf, `${key}-t${n++}`));
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push(<strong key={`${key}-b${n++}`}>{renderInline(text.slice(i + 2, end), `${key}-b${n}`)}</strong>);
        i = end + 2;
        continue;
      }
    }
    const ch = text[i]!;
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push(<code key={`${key}-c${n++}`}>{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }
    if (ch === '*' && text[i + 1] !== ' ' && text[i + 1] !== '*') {
      const end = text.indexOf('*', i + 1);
      if (end > i + 1 && text[end - 1] !== ' ') {
        flush();
        out.push(<em key={`${key}-e${n++}`}>{renderInline(text.slice(i + 1, end), `${key}-e${n}`)}</em>);
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

function linkify(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~\-/%?=&#]*)?/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) !== null) {
    let url = m[0];
    // A sentence's closing punctuation is not part of the link.
    while (/[.,;:]$/.test(url)) url = url.slice(0, -1);
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <a key={`${key}-a${n++}`} href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>,
    );
    last = m.index + url.length;
    re.lastIndex = last;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length === 0 ? [text] : out.map((x, j) => (typeof x === 'string' ? <Fragment key={`${key}-s${j}`}>{x}</Fragment> : x));
}

export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function Markdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className="sg-legal__doc">
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.k) {
          case 'h': {
            const Tag = (['h1', 'h2', 'h3'] as const)[b.level - 1]!;
            return (
              <Tag key={k} id={b.level > 1 ? headingId(b.text) : undefined}>
                {renderInline(b.text, k)}
              </Tag>
            );
          }
          case 'hr':
            return <hr key={k} />;
          case 'quote':
            return <blockquote key={k}>{renderInline(b.text, k)}</blockquote>;
          case 'ul':
            return (
              <ul key={k}>
                {b.items.map((it, j) => (
                  <li key={`${k}-${j}`}>{renderInline(it, `${k}-${j}`)}</li>
                ))}
              </ul>
            );
          case 'table':
            return (
              <div key={k} className="sg-legal__table">
                <table>
                  {b.head !== null ? (
                    <thead>
                      <tr>
                        {b.head.map((c, j) => (
                          <th key={j} scope="col">
                            {renderInline(c, `${k}-h${j}`)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                  ) : null}
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, x) => (
                          <td key={x}>{renderInline(c, `${k}-${j}-${x}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'p':
            return <p key={k}>{renderInline(b.text, k)}</p>;
        }
      })}
    </div>
  );
}
