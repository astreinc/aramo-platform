import { useRef } from 'react';

import type { StudioImportSummary } from './data-source';
import { ConfirmDialog } from './primitives';

// TEMPLATE-IMPORT-1 (Directive v1.1 LOCKED) W-9 — "Import from Word…" in the Studio (platform).
// Two steps in one dialog: (1) what is imported and what is not, then choose a .docx file
// (when a draft is open, the operator confirms it is discarded first); (2) the summary — the
// blocks created, every warning, and the `{{…}}` text that is not a variable. The draft then
// opens in the Studio, where the publishing checks apply as for any draft.

/** W-2 — the same 10 MB limit the server enforces, checked before uploading. */
export const WORD_IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** The operator-facing words for each stable warning code (§3.2). */
export const IMPORT_WARNING_LABEL: Readonly<Record<string, string>> = {
  heading_level_merged: 'Headings 4 to 6 became small headings (H4)',
  list_level_lifted: 'List items deeper than two levels moved up to the second level',
  table_cells_unmerged: 'Merged table cells were split (the text stays in the first cell)',
  table_flattened: 'Tables wider than 8 columns became one paragraph per row',
  table_split: 'Tables longer than 200 rows were split (the header row repeats)',
  image_dropped: 'Images were left out',
  text_box_dropped: 'Text boxes were left out',
  note_dropped: 'Footnotes and endnotes were left out',
  comment_dropped: 'Comments were left out',
  header_footer_dropped: 'Headers and footers were left out',
};

const COUNT_LABEL: ReadonlyArray<[string, string, string]> = [
  ['h2', 'heading', 'headings'],
  ['h3', 'subheading', 'subheadings'],
  ['h4', 'small heading', 'small headings'],
  ['p', 'paragraph', 'paragraphs'],
  ['ul', 'bulleted list', 'bulleted lists'],
  ['ol', 'numbered list', 'numbered lists'],
  ['table', 'table', 'tables'],
  ['page_break', 'page break', 'page breaks'],
];

/** "3 headings · 12 paragraphs · 1 table" (kinds with none are left out). */
export function importCountsLine(counts: Readonly<Record<string, number>>): string {
  return COUNT_LABEL.filter(([k]) => (counts[k] ?? 0) > 0)
    .map(([k, one, many]) => `${counts[k]} ${counts[k] === 1 ? one : many}`)
    .join(' · ');
}

export interface ImportWordDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The open draft's number, when there is one (it is discarded before the import). */
  readonly draftVersion: number | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly summary: StudioImportSummary | null;
  readonly onFile: (file: File) => void;
  /** After the summary: open the imported draft. */
  readonly onDone: () => void;
}

export function ImportWordDialog(p: ImportWordDialogProps) {
  const input = useRef<HTMLInputElement | null>(null);
  const s = p.summary;
  if (s !== null) {
    return (
      <ConfirmDialog
        open={p.open}
        onOpenChange={(o) => {
          if (!o) p.onDone();
        }}
        title={`Imported “${s.title}”`}
        consequence="The draft is ready. Check it, set the signer roles, preview and publish as usual."
        commitLabel="Open the draft"
        onCommit={p.onDone}
      >
        <div className="pws-imp" data-testid="import-summary">
          <p className="pws-imp__counts">{importCountsLine(s.counts) || 'No content was found in the file.'}</p>
          {s.warnings.length > 0 ? (
            <>
              <h3 className="pws-imp__h">Changed or left out</h3>
              <ul className="pws-imp__list">
                {s.warnings.map((w) => (
                  <li key={w.code}>
                    {IMPORT_WARNING_LABEL[w.code] ?? w.code} ({w.count})
                    {w.example !== undefined ? <span className="pws-imp__ex"> e.g. “{w.example}”</span> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {s.unknown_placeholders.length > 0 ? (
            <>
              <h3 className="pws-imp__h">Placeholders to resolve before publishing</h3>
              <p className="pws-imp__note">This text is not a variable, so it would print as typed. Reword it, or add the variable first.</p>
              <ul className="pws-imp__list">
                {s.unknown_placeholders.map((u) => (
                  <li key={u.key}>
                    <code>{`{{${u.key}}}`}</code> ({u.count})
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </ConfirmDialog>
    );
  }
  return (
    <ConfirmDialog
      open={p.open}
      onOpenChange={p.onOpenChange}
      title="Import from Word"
      consequence={
        p.draftVersion !== null
          ? `Draft v${p.draftVersion} is discarded first, then the Word file becomes the new draft. The published version is not changed.`
          : 'The Word file becomes the draft of this template. The published version is not changed.'
      }
      tone={p.draftVersion !== null ? 'privileged' : 'normal'}
      commitLabel={p.busy ? 'Importing…' : p.draftVersion !== null ? 'Discard draft and choose a file…' : 'Choose a .docx file…'}
      busy={p.busy}
      error={p.error}
      onCommit={() => input.current?.click()}
    >
      <div className="pws-imp">
        <p className="pws-imp__note">
          Imported: headings, paragraphs, bold, italic and underline, lists (two levels), tables and manual page breaks. A Title paragraph at the top
          becomes the document title.
        </p>
        <p className="pws-imp__note">
          Not imported: images, headers and footers, footnotes, comments and text boxes. Page breaks set with “Page break before” or section breaks are
          not detected. .docx only, up to 10 MB.
        </p>
        <input
          ref={input}
          type="file"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          hidden
          data-testid="import-word-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file !== undefined) p.onFile(file);
          }}
        />
      </div>
    </ConfirmDialog>
  );
}
