// M-A13 R-1b — argument parsing of the executed-document reissue command (kept apart from
// the entry file so it is unit-tested without running the command).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReissueCommand =
  | { mode: 'inventory'; tenant_id?: string; envelope_ids: string[] }
  | { mode: 'reissue'; tenant_id: string; envelope_ids: string[]; reason: string; apply: boolean };

export function parseReissueArgs(argv: readonly string[]): ReissueCommand {
  const [mode, ...rest] = argv;
  let tenant_id: string | undefined;
  let reason: string | undefined;
  let apply = false;
  const envelope_ids: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    const v = rest[i + 1];
    if (a === '--tenant' && v !== undefined) { tenant_id = v; i += 1; }
    else if (a === '--envelope' && v !== undefined) { envelope_ids.push(v); i += 1; }
    else if (a === '--reason' && v !== undefined) { reason = v; i += 1; }
    else if (a === '--apply') apply = true;
    else throw new Error(`unknown argument "${a ?? ''}"`);
  }
  if (tenant_id !== undefined && !UUID.test(tenant_id)) throw new Error('--tenant must be a UUID');
  for (const e of envelope_ids) if (!UUID.test(e)) throw new Error(`--envelope must be a UUID (got "${e}")`);
  if (mode === 'inventory') {
    if (apply) throw new Error('inventory is read-only: --apply is not accepted');
    return { mode, ...(tenant_id !== undefined ? { tenant_id } : {}), envelope_ids };
  }
  if (mode === 'reissue') {
    if (tenant_id === undefined) throw new Error('reissue needs --tenant <uuid>');
    if (envelope_ids.length === 0) throw new Error('reissue needs at least one --envelope <uuid>');
    if (reason === undefined || reason.trim().length === 0) throw new Error('reissue needs --reason "<text>"');
    return { mode, tenant_id, envelope_ids, reason: reason.trim(), apply };
  }
  throw new Error('first argument must be "inventory" or "reissue"');
}
