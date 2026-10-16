import type { ReactNode } from 'react';

// DOC-TEMPLATE-ADMIN-RTR-1 — shared presentation helpers for the Document Template
// admin screens (icons, date formatting, and the content model). The backend stores
// RTR content as blocks whose text carries {{token}} placeholders (the governed binding
// keys). The approved prototype presents fields as human [Label] chips. These helpers
// bridge the two WITHOUT exposing the schema: {{token}} <-> [Label] round-trip at the
// edit boundary, and segment parsing for chip rendering. The token<->label catalog is
// the backend's (fetched via GET allowed-bindings), so there is no FE mirror to drift.

// ── Icons (copied from the prototype DOM paths) ──────────────────────────
function Svg({ size = 16, stroke = 'currentColor', sw = 1.7, children, style }: { size?: number; stroke?: string; sw?: number; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={style}>
      {children}
    </svg>
  );
}
export const DocIcon = ({ size = 15 }: { size?: number }) => (
  <Svg size={size}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h4" /></Svg>
);
export const DocIconSmall = ({ size = 15, stroke = '#5C6770' }: { size?: number; stroke?: string }) => (
  <Svg size={size} stroke={stroke}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6" /></Svg>
);
export const LockIcon = ({ size = 13, stroke = '#93A0A8', style }: { size?: number; stroke?: string; style?: React.CSSProperties }) => (
  <Svg size={size} stroke={stroke} sw={2} style={style}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Svg>
);
export const CheckIcon = ({ size = 15, stroke = 'currentColor' }: { size?: number; stroke?: string }) => (
  <Svg size={size} stroke={stroke} sw={2.2} style={{ flex: 'none', marginTop: 1 }}><path d="M20 6 9 17l-5-5" /></Svg>
);
export const PlusIcon = () => (<Svg size={12} sw={2.2}><path d="M12 5v14M5 12h14" /></Svg>);
export const ChevronDown = ({ size = 11 }: { size?: number }) => (<Svg size={size} sw={2.2}><path d="M6 9l6 6 6-6" /></Svg>);
export const CloudIcon = ({ size = 12 }: { size?: number }) => (
  <Svg size={size} sw={1.8} style={{ flex: 'none' }}><path d="M7 18a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.5 1.5A3.8 3.8 0 0 1 17.5 18z" /></Svg>
);
export const DocOutline = ({ size = 17 }: { size?: number }) => (
  <Svg size={size} sw={1.8} style={{ flex: 'none' }}><path d="M6 2h9l5 5v15H6zM14 2v6h6" /></Svg>
);
export const SearchIcon = ({ size = 14 }: { size?: number }) => (
  <Svg size={size} sw={1.8} style={{ flex: 'none' }}><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5" /></Svg>
);
export const CheckCircleIcon = ({ size = 17 }: { size?: number }) => (
  <Svg size={size} sw={1.8} style={{ flex: 'none' }}><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12l3 3 5-6" /></Svg>
);
export const ClockIcon = ({ size = 16 }: { size?: number }) => (
  <Svg size={size} sw={1.8} style={{ flex: 'none' }}><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2" /></Svg>
);
export const EyeIcon = ({ size = 15 }: { size?: number }) => (
  <Svg size={size} sw={1.8} style={{ flex: 'none' }}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /></Svg>
);
export const SaveIcon = ({ size = 15 }: { size?: number }) => (
  <Svg size={size} sw={1.8} style={{ flex: 'none' }}><path d="M5 3h11l3 3v15H5zM8 3v5h7M8 21v-7h8v7" /></Svg>
);
export const TabIcon = ({ path }: { path: string }) => (<Svg size={15} sw={1.8} style={{ flex: 'none' }}><path d={path} /></Svg>);
export const DragDots = () => (
  <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true">
    <circle cx="3" cy="3" r="1.4" /><circle cx="9" cy="3" r="1.4" /><circle cx="3" cy="8" r="1.4" />
    <circle cx="9" cy="8" r="1.4" /><circle cx="3" cy="13" r="1.4" /><circle cx="9" cy="13" r="1.4" />
  </svg>
);

// ── Field sources (chip icon + Insert/rail grouping) ─────────────────────
// Derived from the governed binding KEY's source prefix (the catalog itself is the
// server's). Groups with no live key are simply never rendered.
export type FieldSource = 'person' | 'building' | 'briefcase' | 'doc' | 'dollar';
export const SOURCE_PATH: Record<FieldSource, string> = {
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  building: 'M4 21V6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15M14 10h5a1 1 0 0 1 1 1v10M2 21h20',
  briefcase: 'M3 9h18M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  doc: 'M6 2h9l5 5v15H6zM14 2v6h6',
  dollar: 'M12 2v20M17 6.5c-.6-1.5-2.4-2.5-5-2.5-3 0-5 1.4-5 3.5S9 10.6 12 11s5 1.6 5 3.5-2 3.5-5 3.5c-2.6 0-4.4-1-5-2.5',
};
export const JOB_DESCRIPTION_KEY = 'requisition.description';
export const TALENT_NAME_KEY = 'talent.full_name';

export function sourceOf(key: string): FieldSource {
  if (key === JOB_DESCRIPTION_KEY) return 'doc';
  if (key.startsWith('talent.') || key.startsWith('recruiter.')) return 'person';
  if (key.startsWith('client.') || key.startsWith('recruiting_company.')) return 'building';
  if (key.startsWith('requisition.')) return 'briefcase';
  if (key.startsWith('agreed_pay')) return 'dollar';
  return 'doc';
}
export const SourceIcon = ({ source, size = 16 }: { source: FieldSource; size?: number }) => (
  <Svg size={size} sw={1.8} style={{ flex: 'none' }}><path d={SOURCE_PATH[source]} /></Svg>
);

const FIELD_GROUPS: ReadonlyArray<{ id: string; label: string; test: (k: string) => boolean }> = [
  { id: 'talent', label: 'Talent', test: (k) => k.startsWith('talent.') },
  { id: 'client', label: 'Client', test: (k) => k.startsWith('client.') },
  { id: 'requisition', label: 'Requisition', test: (k) => k.startsWith('requisition.') },
  { id: 'recruiting', label: 'Recruiting org', test: (k) => k.startsWith('recruiting_company.') },
  { id: 'recruiter', label: 'Recruiter', test: (k) => k.startsWith('recruiter.') },
  { id: 'pay', label: 'Agreed pay', test: (k) => k.startsWith('agreed_pay') },
];
export interface FieldGroup<T> { readonly id: string; readonly label: string; readonly source: FieldSource; readonly items: T[] }
// Group governed bindings in the fixed source order; a key outside the known sources
// falls into its server-provided group (never dropped, never invented).
export function groupBindings<T extends { key: string; group: string }>(bindings: readonly T[]): FieldGroup<T>[] {
  const out: FieldGroup<T>[] = FIELD_GROUPS.map((g) => ({ id: g.id, label: g.label, source: 'doc' as FieldSource, items: [] as T[] }));
  for (const b of bindings) {
    const gi = FIELD_GROUPS.findIndex((g) => g.test(b.key));
    if (gi >= 0) { const g = out[gi]; if (g != null) g.items.push(b); continue; }
    let g = out.find((x) => x.id === `other:${b.group}`);
    if (g == null) { g = { id: `other:${b.group}`, label: b.group, source: 'doc', items: [] }; out.push(g); }
    g.items.push(b);
  }
  return out
    .filter((g) => g.items.length > 0)
    .map((g) => ({ ...g, source: g.items[0] != null ? sourceOf(g.items[0].key) : 'doc' }));
}

// ── Signature block (fixed, appended by Aramo e-sign) ────────────────────
// Drawn in a RENDER only when the server says it appends one (`signature_block` on the
// preview/render or version response). Absent → previews draw no signature (never a
// false preview). Single switch so it turns on automatically when the field exists.
export interface SignatureInfo { readonly printedName: string | null }
export function signatureFrom(x: unknown): SignatureInfo | null {
  if (x == null || typeof x !== 'object') return null;
  const sb = (x as Record<string, unknown>).signature_block;
  if (sb == null || typeof sb !== 'object') return null;
  const pn = (sb as Record<string, unknown>).printed_name;
  return { printedName: typeof pn === 'string' && pn.trim() !== '' ? pn : null };
}

// mode 'template' shows the printed-name FIELD chip; 'render' shows the resolved value.
export function SignatureBlock({ mode, printedName, nameLabel, className, testId }: {
  readonly mode: 'template' | 'render';
  readonly printedName?: string | null;
  readonly nameLabel: string;
  readonly className?: string;
  readonly testId?: string;
}) {
  return (
    <div className={`dt-sig${className != null ? ` ${className}` : ''}`} data-testid={testId}>
      <div>
        <div className="dt-sig__l">TALENT SIGNATURE</div>
        <div className="dt-sig__here">Sign here</div>
      </div>
      <div>
        <div className="dt-sig__l">PRINTED NAME</div>
        <div className="dt-sig__line">
          {mode === 'template' ? <span className="dt-chip">{nameLabel}</span> : <span>{printedName ?? ''}</span>}
        </div>
      </div>
      <div>
        <div className="dt-sig__l">DATE SIGNED</div>
        <div className="dt-sig__line dt-sig__line--muted">Stamped by Aramo e-sign at signing</div>
      </div>
    </div>
  );
}

export const InfoCircle = ({ size = 14, stroke = 'currentColor' }: { size?: number; stroke?: string }) => (
  <Svg size={size} stroke={stroke} sw={1.9} style={{ flex: 'none' }}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.5" /></Svg>
);

// ── Dates ────────────────────────────────────────────────────────────────
// Human month-day-year, e.g. "Oct 9, 2026" (prototype style). Never a raw ISO/locale ts.
export function fmtDate(iso: string | null): string {
  if (iso == null) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Content model ────────────────────────────────────────────────────────
export interface Block { type: 'HEADING' | 'TEXT'; text: string }
export interface BindingMap { labelByToken: Record<string, string>; tokenByLabel: Record<string, string> }

export function emptyBindingMap(): BindingMap { return { labelByToken: {}, tokenByLabel: {} }; }

// Parse a stored RTR field_schema into { title, blocks } where each block keeps its
// stored type (HEADING | TEXT) and its text converted to editable [Label] form. Tolerant
// of an empty/not-yet-authored draft. An unrecognised block type reads as TEXT.
export function parseContent(fieldSchema: unknown, m: BindingMap): { title: string; blocks: Block[] } {
  if (fieldSchema == null || typeof fieldSchema !== 'object') return { title: '', blocks: [] };
  const obj = fieldSchema as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title : '';
  const rawBlocks = Array.isArray(obj.blocks) ? obj.blocks : [];
  const blocks = rawBlocks.map((b): Block => {
    const bb = b as Record<string, unknown>;
    return {
      type: bb.type === 'HEADING' ? 'HEADING' : 'TEXT',
      text: tokensToLabels(typeof bb.text === 'string' ? bb.text : '', m),
    };
  });
  return { title, blocks };
}

// Build a field_schema (blocks) from editable [Label] blocks for PATCH. Each block keeps
// its type — a HEADING stays a HEADING; only the text is converted back to {{token}}s.
export function buildFieldSchema(renderSchemaVersion: string, title: string, blocks: readonly Block[], m: BindingMap): unknown {
  return {
    render_schema_version: renderSchemaVersion,
    title,
    blocks: blocks.map((b) => ({ type: b.type, text: labelsToTokens(b.text, m) })),
  };
}

export function bindingMapFrom(bindings: ReadonlyArray<{ key: string; label: string }>): BindingMap {
  const labelByToken: Record<string, string> = {};
  const tokenByLabel: Record<string, string> = {};
  for (const b of bindings) { labelByToken[b.key] = b.label; tokenByLabel[b.label] = b.key; }
  return { labelByToken, tokenByLabel };
}

const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;
const LABEL_RE = /\[([^\]]+)\]/g;

// Storage {{token}} -> editable [Label] (unknown token keeps its raw key in brackets).
export function tokensToLabels(text: string, m: BindingMap): string {
  return text.replace(TOKEN_RE, (_w, key: string) => `[${m.labelByToken[key] ?? key}]`);
}
// Editable [Label] -> storage {{token}} (unknown label becomes {{label}} so the backend
// closed-binding validation rejects it — mirroring the prototype "unknown field" block).
export function labelsToTokens(text: string, m: BindingMap): string {
  return text.replace(LABEL_RE, (_w, label: string) => `{{${m.tokenByLabel[label.trim()] ?? label.trim()}}}`);
}

export type Seg =
  | { kind: 'text'; t: string }
  | { kind: 'field'; t: string }
  | { kind: 'bad'; t: string };

// Split editable [Label] text into renderable segments. A [Label] not in the catalog is
// a "bad" (unknown field) segment — it blocks approval.
export function parseLabelSegments(text: string, m: BindingMap): Seg[] {
  const out: Seg[] = [];
  for (const part of text.split(/(\[[^\]]+\])/)) {
    if (part === '') continue;
    const mm = part.match(/^\[([^\]]+)\]$/);
    if (mm != null) {
      const label = (mm[1] ?? "").trim();
      out.push(m.tokenByLabel[label] !== undefined ? { kind: 'field', t: label } : { kind: 'bad', t: label });
    } else {
      out.push({ kind: 'text', t: part });
    }
  }
  return out;
}

// Render segments as inline text + chips (reading view / detail / version / editor-read).
export function Segments({ text, map, chipSize }: { text: string; map: BindingMap; chipSize?: 'sm' | 'md' }) {
  const segs = parseLabelSegments(text, map);
  return (
    <>
      {segs.map((s, i) => {
        if (s.kind === 'text') return <span key={i}>{s.t}</span>;
        if (s.kind === 'field') return <span key={i} className="dt-chip" style={chipSize === 'md' ? { fontSize: '12.5px' } : undefined}>{s.t}</span>;
        return (
          <span key={i} className="dt-chip dt-chip--bad" style={chipSize === 'md' ? { fontSize: '12.5px' } : undefined} title="Not a governed field — remove it or insert a field from the list">
            {s.t} · unknown field
          </span>
        );
      })}
    </>
  );
}
