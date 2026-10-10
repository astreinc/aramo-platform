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

// Parse a stored RTR field_schema into { title, paras } where each para is the block's
// text converted to editable [Label] form. Tolerant of an empty/not-yet-authored draft.
export function parseContent(fieldSchema: unknown, m: BindingMap): { title: string; paras: string[] } {
  if (fieldSchema == null || typeof fieldSchema !== 'object') return { title: '', paras: [] };
  const obj = fieldSchema as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title : '';
  const rawBlocks = Array.isArray(obj.blocks) ? obj.blocks : [];
  const paras = rawBlocks.map((b) => {
    const bb = b as Record<string, unknown>;
    return tokensToLabels(typeof bb.text === 'string' ? bb.text : '', m);
  });
  return { title, paras };
}

// Build a field_schema (blocks) from editable [Label] paragraphs for PATCH. Blank
// paragraphs are kept while editing but dropped at the API boundary by the caller.
export function buildFieldSchema(renderSchemaVersion: string, title: string, paras: readonly string[], m: BindingMap): unknown {
  return {
    render_schema_version: renderSchemaVersion,
    title,
    blocks: paras.map((p) => ({ type: 'TEXT' as const, text: labelsToTokens(p, m) })),
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

// ── Sample preview substitution (fixed safe values; mirrors the backend sample set) ──
// Keyed by LABEL so it works off the fetched catalog. Highlighted in the preview paper.
export const SAMPLE_BY_LABEL: Readonly<Record<string, string>> = {
  'Talent full name': 'Ravi Shankar',
  'Client name': 'Mindlance',
  'Requisition title': 'Business Analyst - Multi-Family',
  'Requisition reference': 'REQ-1001',
  'Recruiting organization name': 'Astre Consulting',
  'Recruiter name': 'Deepika Rao',
  'Agreed pay amount': '$62',
  Currency: 'USD',
  'Pay period': 'hour',
};

// Render a paragraph with sample values filled + highlighted (preview paper).
export function SampleSegments({ text, map }: { text: string; map: BindingMap }) {
  const segs = parseLabelSegments(text, map);
  return (
    <>
      {segs.map((s, i) => {
        if (s.kind === 'text') return <span key={i}>{s.t}</span>;
        if (s.kind === 'field') return <span key={i} className="dt-pvfill">{SAMPLE_BY_LABEL[s.t] ?? s.t}</span>;
        return <span key={i} style={{ background: '#FBE9E4', color: '#B3402A', padding: '0 3px', borderRadius: 3 }}>[{s.t} — unknown]</span>;
      })}
    </>
  );
}
