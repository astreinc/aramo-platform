// D2 — the ONE shared date formatter for surfaces that were rendering a raw
// ISO string to the user (the activity timeline #7 and the cockpit start_date
// edit field #14). Returns the calendar date as `YYYY-MM-DD` — the single
// shape that is both a valid `<input type="date">` value AND a clean display,
// so one formatter serves the read display and the date editor alike.
//
// Timezone-stable: the UTC calendar date of the stored instant (a plain
// `start_date` is stored at midnight UTC, so its date never drifts; an
// activity `created_at` shows the UTC date of the event). Empty in → empty
// out. Unparseable in → returned unchanged, so a real value is never silently
// blanked if the wire shape is ever something this doesn't anticipate.
export function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
