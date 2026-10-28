#!/usr/bin/env bash
# Aramo — historic plaintext backups: one final disposition per file (M-A8 §1.4).
#
# Input: the verified inventory TSV (no header; one row per file):
#   <path> <size> <mtime ISO-8601> <mode> <sha256>
# (Aramo/documents/Aramo-M-A8-Historical-Backup-Inventory-20261028.tsv). Every file
# gets exactly one disposition:
#   D1>D3  Migrated (encrypted + uploaded + verified), then the local plaintext Retired;
#   D2>D3  Retained temporarily (named reason + review condition), migrated, then
#          Retired once the review condition holds;
#   D3     Retired (no data to keep: the non-dump .sql scripts).
#
# Subcommands (all default to read-only / dry-run):
#   plan     --inventory INV --out MANIFEST [--d2 PATH]… [--no-default-d2]
#            Classify every row and write the per-file disposition manifest. Default
#            D2 = the newest pre-deploy dump-main and dump-intelligence (the current
#            rollback baseline, §1.4.2).
#   validate --inventory INV --manifest MANIFEST
#            Every inventory row exactly once with identical sha256/size/mtime/mode,
#            dispositions legal for their class, D2 rows carry reason + review.
#   migrate  --inventory INV --manifest MANIFEST --record RECORD [--no-upload]
#            D1 on the box (root): re-hash every non-D3-only source against the
#            inventory (a changed file is refused), encrypt it with
#            aramo-backup-encrypt-existing.sh (one run per source directory and kind),
#            upload with SSE-KMS (checksum-verified) and write RECORD: one row per
#            file with run_id, key, VersionId, encrypted sha256/size, verified=yes.
#   retire   --inventory INV --manifest MANIFEST --record RECORD
#            [--restore-pass REPORT]… [--release-d2 --routine-restore-pass REPORT]
#            [--execute-d3 --inventory-sha256 SHA] [--log FILE]
#            D3. DRY-RUN unless BOTH --execute-d3 and --inventory-sha256 equal to the
#            sha256 of INV are given (the §4.3 disposal checkpoint runs against the exact
#            verified inventory). A file is retired only when:
#              - its current sha256 + size still equal the inventory;
#              - D3: always eligible (scripts with no data);
#              - D1>D3: RECORD shows a verified upload of the same source sha256, and
#                for a database dump a --restore-pass report (restore-checks PASS) for
#                its migrated run_id;
#              - D2>D3: as D1>D3, plus --release-d2 with a PASS restore report of a
#                routine (new encrypted) run.
#            Deletion overwrites the file (shred -u when available) then unlinks it.
#
# No blanket destruction: only rows of the validated manifest are ever touched.
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/backup/lib.sh disable=SC1091
source "$DIR/lib.sh"
BK_TAG="aramo-historic-disposition"

MANIFEST_MAGIC="# aramo-historic-disposition v1"
SHA_RE='^[0-9a-f]{64}$'

# classify <path> → class
classify() {
  local name
  name="$(basename "$1")"
  case "$name" in
    *.sql)
      case "$name" in
        *intelligence*) echo dump-intelligence ;;
        pre-*) echo dump-main ;;
        *) echo sql-script ;;
      esac
      ;;
    *.dump)
      case "$name" in
        *dropped-schemas*) echo dump-dropped-schemas ;;
        *intelligence*) echo dump-intelligence ;;
        *) echo dump-main ;;
      esac
      ;;
    env-* | .env.* | .env-*) echo env-copy ;;
    *) echo unknown ;;
  esac
}

is_dump() { case "$1" in dump-*) return 0 ;; *) return 1 ;; esac; }

# inventory rows, validated: path size mtime mode sha
read_inventory() {
  local inv="$1"
  [ -s "$inv" ] || bk_die "inventory missing or empty: ${inv}" 2
  awk -F'\t' -v re="$SHA_RE" '
    NF != 5 || $1 !~ /^\// || $2 !~ /^[0-9]+$/ || $4 !~ /^[0-7]{3,4}$/ || $5 !~ re {
      printf "inventory line %d is malformed\n", NR > "/dev/stderr"; bad = 1
    }
    seen[$1]++ == 1 { printf "inventory path listed twice (line %d)\n", NR > "/dev/stderr"; bad = 1 }
    END { exit bad }' "$inv" || bk_die "inventory ${inv} is not valid" 2
}

manifest_rows() { grep -v '^#' "$1" | awk 'NF'; }

cmd_plan() {
  local inv="" out="" default_d2=1
  local -a d2=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --inventory) inv="${2:-}"; shift 2 ;;
      --out) out="${2:-}"; shift 2 ;;
      --d2) d2+=("${2:-}"); shift 2 ;;
      --no-default-d2) default_d2=0; shift ;;
      *) bk_die "plan: unknown argument: $1" 2 ;;
    esac
  done
  [ -n "$inv" ] && [ -n "$out" ] || bk_die "plan: --inventory and --out are required" 2
  [ ! -e "$out" ] || bk_die "plan: refusing to overwrite ${out}" 2
  read_inventory "$inv"

  local classes="$out.classes"
  while IFS=$'\t' read -r path size mtime mode sha; do
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$path" "$sha" "$size" "$mtime" "$mode" "$(classify "$path")"
  done <"$inv" >"$classes"
  if awk -F'\t' '$6=="unknown"{print "unclassified: " $1; bad=1} END{exit !bad}' "$classes" >&2; then
    rm -f "$classes"
    bk_die "plan: some files could not be classified; add a rule or remove them from the inventory first"
  fi

  # Default D2: the newest pre-deploy dump-main and dump-intelligence by mtime.
  if [ "$default_d2" = 1 ]; then
    local c p
    for c in dump-main dump-intelligence; do
      p="$(awk -F'\t' -v c="$c" '$6==c {n=split($1, a, "/"); if (a[n] ~ /^pre-/) print $4 "\t" $1}' "$classes" | sort | tail -1 | cut -f2)"
      [ -z "$p" ] || d2+=("$p")
    done
  fi
  local x
  for x in "${d2[@]+"${d2[@]}"}"; do
    awk -F'\t' -v p="$x" '$1==p {f=1} END{exit !f}' "$classes" || bk_die "plan: --d2 path not in inventory: ${x}" 2
  done

  {
    printf '%s\n' "$MANIFEST_MAGIC"
    printf '# inventory_sha256=%s\n' "$(bk_sha256 "$inv")"
    printf '# inventory_rows=%s\n' "$(awk 'END{print NR}' "$inv")"
    printf '# created_at=%s\n' "$(bk_now_iso)"
    printf '#path\tsha256\tsize\tmtime\tmode\tclass\tdisposition\treason\treview\n'
    printf '%s\n' "${d2[@]+"${d2[@]}"}" >"$out.d2"
    awk -F'\t' -v d2file="$out.d2" '
      BEGIN { while ((getline l < d2file) > 0) if (l != "") hold[l] = 1 }
      {
        if ($6 == "sql-script") { d = "D3"; r = "query or rollback script, no table data; text preserved in the deploy record"; v = "-" }
        else if ($1 in hold) { d = "D2>D3"; r = "current rollback baseline"; v = "first encrypted routine backup and its restore test PASS" }
        else if ($6 == "env-copy") { d = "D1>D3"; r = "secrets snapshot: encrypted to historic/env/, verified, then the local copy retired"; v = "-" }
        else { d = "D1>D3"; r = "plaintext dump: encrypted to historic/ (30-day window), verified, local plaintext retired after the restore test of the migrated set"; v = "-" }
        printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", $1, $2, $3, $4, $5, $6, d, r, v
      }' "$classes"
  } >"$out"
  rm -f "$classes" "$out.d2"
  chmod 600 "$out"
  summary "$out"
  printf '%s\n' "$out"
}

summary() {
  manifest_rows "$1" | awk -F'\t' '{c[$6 " " $7]++; t++} END {for (k in c) printf "  %-26s %s\n", k, c[k]; printf "  %-26s %s\n", "total", t}' | sort >&2
}

cmd_validate() {
  local inv="" man=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --inventory) inv="${2:-}"; shift 2 ;;
      --manifest) man="${2:-}"; shift 2 ;;
      *) bk_die "validate: unknown argument: $1" 2 ;;
    esac
  done
  validate "$inv" "$man"
  bk_log "manifest VALID: $(manifest_rows "$man" | wc -l | tr -d ' ') rows match inventory $(bk_sha256 "$inv")"
  summary "$man"
}

validate() {
  local inv="$1" man="$2"
  [ -n "$inv" ] && [ -n "$man" ] || bk_die "--inventory and --manifest are required" 2
  read_inventory "$inv"
  [ -f "$man" ] || bk_die "manifest not found: ${man}" 2
  [ "$(head -1 "$man")" = "$MANIFEST_MAGIC" ] || bk_die "not a disposition manifest: ${man}" 2
  local want
  want="$(sed -n 's/^# inventory_sha256=//p' "$man")"
  [ "$want" = "$(bk_sha256 "$inv")" ] || bk_die "manifest was planned from a different inventory (sha256 ${want:-none})" 2
  manifest_rows "$man" | awk -F'\t' -v inv="$inv" '
    BEGIN {
      while ((getline line < inv) > 0) { split(line, f, "\t"); want[f[1]] = f[5] "\t" f[2] "\t" f[3] "\t" f[4]; n++ }
    }
    {
      if (NF != 9) { printf "manifest row %d has %d columns\n", NR, NF; bad = 1; next }
      if (!($1 in want)) { printf "manifest row not in inventory: %s\n", $1; bad = 1; next }
      if (seen[$1]++) { printf "manifest lists a file twice: %s\n", $1; bad = 1; next }
      if ($2 "\t" $3 "\t" $4 "\t" $5 != want[$1]) { printf "manifest row differs from inventory: %s\n", $1; bad = 1 }
      if ($6 == "sql-script" && $7 != "D3") { printf "sql-script must be D3: %s\n", $1; bad = 1 }
      if ($6 != "sql-script" && $7 != "D1>D3" && $7 != "D2>D3") { printf "data file must be D1>D3 or D2>D3: %s\n", $1; bad = 1 }
      if ($6 !~ /^(dump-main|dump-intelligence|dump-dropped-schemas|env-copy|sql-script)$/) { printf "unknown class %s: %s\n", $6, $1; bad = 1 }
      if ($7 == "D2>D3" && ($8 == "" || $8 == "-" || $9 == "" || $9 == "-")) { printf "D2 row needs a reason and a review condition: %s\n", $1; bad = 1 }
      m++
    }
    END {
      for (p in want) if (!(p in seen)) { printf "inventory file missing from manifest: %s\n", p; bad = 1 }
      exit bad
    }' >&2 || bk_die "manifest does not match the inventory" 2
}

cmd_migrate() {
  local inv="" man="" record="" upload_flag=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --inventory) inv="${2:-}"; shift 2 ;;
      --manifest) man="${2:-}"; shift 2 ;;
      --record) record="${2:-}"; shift 2 ;;
      --no-upload) upload_flag="--no-upload"; shift ;;
      *) bk_die "migrate: unknown argument: $1" 2 ;;
    esac
  done
  [ -n "$record" ] || bk_die "migrate: --record is required" 2
  [ ! -e "$record" ] || bk_die "migrate: refusing to overwrite ${record}" 2
  validate "$inv" "$man"

  # Re-hash every source to migrate; a changed or missing file stops the whole run.
  local rows="$record.rows" path sha size mtime mode class disp reason review bad=0
  manifest_rows "$man" | awk -F'\t' '$7 != "D3"' >"$rows"
  while IFS=$'\t' read -r path sha size mtime mode class disp reason review; do
    if ! [ -f "$path" ]; then
      bk_log "MISSING: ${path}"
      bad=1
    elif [ "$(bk_sha256 "$path")" != "$sha" ] || [ "$(bk_size "$path")" != "$size" ]; then
      bk_log "CHANGED since the inventory (sha256/size): ${path}"
      bad=1
    fi
  done <"$rows"
  [ "$bad" = 0 ] || { rm -f "$rows"; bk_die "migrate: sources differ from the inventory; nothing was encrypted"; }

  printf '#path\tsource_sha256\tsource_size\tclass\trun_id\tkey\tversion_id\tsha256\tsize\tverified\n' >"$record"
  chmod 600 "$record"
  # One encrypt-existing run per (kind, source directory): basenames are unique there.
  local groups kind dirn label slug run_dir n=0
  groups="$(awk -F'\t' '{k = ($6 == "env-copy") ? "env" : "dump"; d = $1; sub(/\/[^\/]*$/, "", d); print k "\t" d}' "$rows" | sort -u)"
  while IFS=$'\t' read -r kind dirn <&3; do
    [ -n "$kind" ] || continue
    # label: the tail of the directory path + a short hash of the whole path (unique, ≤ 64 chars)
    slug="$(printf '%s' "$dirn" | tr -c 'A-Za-z0-9' '-' | sed 's/--*/-/g; s/^-//; s/-$//' | rev | cut -c1-32 | rev | sed 's/^-//')"
    label="d1-${kind}-${slug:-root}-$(printf '%s' "$dirn" | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-6)"
    local -a files=()
    while IFS= read -r path; do files+=("$path"); done < <(
      awk -F'\t' -v k="$kind" -v d="$dirn" '{kk = ($6 == "env-copy") ? "env" : "dump"; dd = $1; sub(/\/[^\/]*$/, "", dd); if (kk == k && dd == d) print $1}' "$rows"
    )
    run_dir="$(bash "$DIR/aramo-backup-encrypt-existing.sh" --kind "$kind" --label "$label" ${upload_flag} "${files[@]}" </dev/null)" ||
      bk_die "migrate: encryption/upload failed for ${dirn} (${kind}); the record lists the groups completed before it"
    record_run "$run_dir" "$rows" >>"$record"
    n=$((n + ${#files[@]}))
  done 3<<<"$groups"
  rm -f "$rows"
  bk_log "migrate: ${n} file(s) encrypted; record ${record} ($(awk -F'\t' '$10=="yes"' "$record" | wc -l | tr -d ' ') verified uploads)"
  printf '%s\n' "$record"
}

# record_run <run_dir> <rows>: one record line per source of an encrypt-existing run.
record_run() {
  local run_dir="$1" rows="$2" run_id
  run_id="$(bk_manifest_get "$run_dir/manifest.tsv" run_id)"
  awk -F'\t' -v rid="$run_id" -v up="$run_dir/uploads.tsv" -v rows="$rows" '
    BEGIN {
      while ((getline l < rows) > 0) { split(l, f, "\t"); cls[f[1]] = f[6] }
      while ((getline l < up) > 0) { if (l ~ /^#/) continue; split(l, u, "\t"); key[u[1]] = u[2]; ver[u[1]] = u[3]; ok[u[1]] = u[6] }
    }
    $1 == "artifact" {
      src = $11; sub(/@[^@]*@[^@]*$/, "", src)
      size = $11; sub(/^.*@/, "", size)
      v = ($2 in ok && ok[$2] == "yes") ? "yes" : "local-only"
      printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", src, $10, size, cls[src], rid, ($2 in key ? key[$2] : "-"), ($2 in ver ? ver[$2] : "-"), $6, $5, v
    }' "$run_dir/manifest.tsv"
}

# report_pass <report> → prints "<class> <run_id>" when the restore report is PASS.
report_pass() {
  local r="$1"
  [ -f "$r" ] || bk_die "restore report not found: ${r}" 2
  grep -qx 'overall=PASS' "$r" || bk_die "restore report is not PASS: ${r}" 2
  sed -n '1s/^restore-test run_id=\([^ ]*\) class=\([^ ]*\) .*$/\2 \1/p' "$r"
}

secure_delete() {
  local f="$1"
  if command -v shred >/dev/null 2>&1; then
    shred -u -n 1 -z -- "$f"
  else
    # Portable fallback: overwrite in place, flush, unlink.
    dd if=/dev/zero of="$f" bs=65536 count=$(( ($(bk_size "$f") + 65535) / 65536 )) conv=notrunc 2>/dev/null
    sync
    rm -f -- "$f"
  fi
}

cmd_retire() {
  local inv="" man="" record="" execute=0 inv_sha="" release_d2=0 log=""
  local -a passes=() routine_passes=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --inventory) inv="${2:-}"; shift 2 ;;
      --manifest) man="${2:-}"; shift 2 ;;
      --record) record="${2:-}"; shift 2 ;;
      --restore-pass) passes+=("${2:-}"); shift 2 ;;
      --release-d2) release_d2=1; shift ;;
      --routine-restore-pass) routine_passes+=("${2:-}"); shift 2 ;;
      --execute-d3) execute=1; shift ;;
      --inventory-sha256) inv_sha="${2:-}"; shift 2 ;;
      --log) log="${2:-}"; shift 2 ;;
      *) bk_die "retire: unknown argument: $1" 2 ;;
    esac
  done
  validate "$inv" "$man"
  if [ "$execute" = 1 ]; then
    [[ "$inv_sha" =~ $SHA_RE ]] || bk_die "retire: --execute-d3 needs --inventory-sha256 <sha256 of the verified inventory>" 2
    [ "$inv_sha" = "$(bk_sha256 "$inv")" ] ||
      bk_die "retire: --inventory-sha256 does not match ${inv}; D3 runs only against the exact verified inventory" 2
  fi
  [ -z "$record" ] || [ -f "$record" ] || bk_die "retire: record not found: ${record}" 2

  local passed_runs="" routine_ok=0 p line
  for p in "${passes[@]+"${passes[@]}"}"; do
    line="$(report_pass "$p")"
    passed_runs="${passed_runs} ${line#* }"
  done
  for p in "${routine_passes[@]+"${routine_passes[@]}"}"; do
    line="$(report_pass "$p")"
    [ "${line%% *}" = "routine" ] || bk_die "--routine-restore-pass must be a report of a routine run: ${p}" 2
    routine_ok=1
  done

  local out="${log:-/dev/null}" path sha size mtime mode class disp reason review
  local retired=0 kept=0 failed=0 why rec_line rec_run
  [ -z "$log" ] || { : >"$log"; chmod 600 "$log"; }
  while IFS=$'\t' read -r path sha size mtime mode class disp reason review; do
    why=""
    if [ "$disp" != "D3" ]; then
      rec_line=""
      if [ -n "$record" ]; then
        rec_line="$(awk -F'\t' -v p="$path" -v s="$sha" '$1==p && $2==s && $10=="yes" {print; exit}' "$record")"
      fi
      if [ -z "$rec_line" ]; then
        why="no verified D1 copy in the record"
      elif is_dump "$class"; then
        rec_run="$(printf '%s' "$rec_line" | cut -f5)"
        case " ${passed_runs} " in *" ${rec_run} "*) ;; *) why="no PASS restore report for migrated run ${rec_run}" ;; esac
      fi
      if [ -z "$why" ] && [ "$disp" = "D2>D3" ]; then
        if [ "$release_d2" != 1 ]; then
          why="D2 retained: ${reason} (review: ${review})"
        elif [ "$routine_ok" != 1 ]; then
          why="D2 release needs --routine-restore-pass (PASS report of a routine run)"
        fi
      fi
    fi
    if [ -z "$why" ]; then
      if ! [ -f "$path" ]; then
        why="already absent"
      elif [ "$(bk_size "$path")" != "$size" ] || [ "$(bk_sha256 "$path")" != "$sha" ]; then
        why="CHANGED since the inventory — refused"
        failed=$((failed + 1))
      fi
    fi
    if [ -n "$why" ]; then
      printf 'KEEP\t%s\t%s\t%s\n' "$disp" "$path" "$why" | tee -a "$out" >&2
      kept=$((kept + 1))
    elif [ "$execute" = 1 ]; then
      if secure_delete "$path"; then
        printf 'RETIRED\t%s\t%s\t%s\n' "$disp" "$path" "$sha" | tee -a "$out" >&2
        retired=$((retired + 1))
      else
        printf 'FAILED\t%s\t%s\tdelete failed\n' "$disp" "$path" | tee -a "$out" >&2
        failed=$((failed + 1))
      fi
    else
      printf 'WOULD-RETIRE\t%s\t%s\t%s\n' "$disp" "$path" "$sha" | tee -a "$out" >&2
      retired=$((retired + 1))
    fi
  done < <(manifest_rows "$man")
  local verb="would-retire"
  [ "$execute" = 1 ] && verb="retired"
  printf 'retire %s=%s kept=%s failed=%s mode=%s\n' "$verb" "$retired" "$kept" "$failed" "$([ "$execute" = 1 ] && echo EXECUTE || echo DRY-RUN)"
  [ "$failed" = 0 ]
}

main() {
  local cmd="${1:-}"
  [ $# -eq 0 ] || shift
  case "$cmd" in
    plan) cmd_plan "$@" ;;
    validate) cmd_validate "$@" ;;
    migrate) cmd_migrate "$@" ;;
    retire) cmd_retire "$@" ;;
    -h | --help | "") sed -n '2,46p' "$0"; [ -n "$cmd" ] ;;
    *) bk_die "unknown subcommand: ${cmd} (plan | validate | migrate | retire)" 2 ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
