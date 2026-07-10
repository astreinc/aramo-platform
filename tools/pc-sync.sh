#!/usr/bin/env bash
#
# pc-sync.sh — the platform-console R-SYNC closure sequence, mechanized.
#
# WHY THIS EXISTS
#   platform-console is an integration branch off main. After every PR merges
#   into it, main may have moved, so we forward-merge main -> platform-console
#   ("R-SYNC") to keep platform-console current. Across the first three Inc-2
#   closures this was a hand-run checklist, and the SAME footgun fired 3/3: a
#   fresh worktree checks out the STALE LOCAL `platform-console` ref (behind
#   origin, because the PR was merged server-side via the GitHub API), and
#   merging main onto it would DROP the just-merged PR. The manual fix was
#   always "git reset --hard origin/platform-console FIRST". This script turns
#   that named checklist step into code — the stale-base reset is no longer a
#   thing you can forget.
#
# WHAT IT DOES (and only this)
#   1. git fetch origin
#   2. worktree onto platform-console, then HARD-RESET it to origin/platform-console
#      (the stale-base guard, now unconditional)
#   3. merge-tree PREVIEW of platform-console <- main
#   4. git merge --no-ff origin/main   (the R-SYNC merge)
#   5. git push origin platform-console
#
# WHAT IT DELIBERATELY DOES NOT DO (the human steps stay human)
#   - It does NOT merge any PR (PR merges are a human decision, done server-side).
#   - It does NOT resolve conflicts. On ANY conflict (preview or merge) it STOPS,
#     leaves the tree untouched (merge --abort), and reports — you resolve by hand.
#   - It does NOT force-push.
#
# USAGE
#   tools/pc-sync.sh                 # auto-generates the merge message
#   tools/pc-sync.sh "custom msg"    # override the merge-commit message
#
# EXIT CODES
#   0  synced-and-pushed, OR already-current (nothing to do)
#   1  conflict detected (nothing pushed; resolve by hand)
#   2  precondition failure (not a git repo, missing remote/branches, etc.)

set -euo pipefail

REMOTE="origin"
BRANCH="platform-console"
MAIN="main"
TRAILER="Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"

die() { echo "pc-sync: ERROR: $*" >&2; exit 2; }
note() { echo "pc-sync: $*"; }

# ── preconditions ──────────────────────────────────────────────────────────
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git work tree"
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
git remote get-url "$REMOTE" >/dev/null 2>&1 || die "remote '$REMOTE' not configured"

note "fetching $REMOTE ..."
git fetch "$REMOTE" --quiet

git rev-parse --verify "$REMOTE/$BRANCH" >/dev/null 2>&1 || die "$REMOTE/$BRANCH not found"
git rev-parse --verify "$REMOTE/$MAIN"   >/dev/null 2>&1 || die "$REMOTE/$MAIN not found"

ORIGIN_BRANCH_SHA="$(git rev-parse "$REMOTE/$BRANCH")"
ORIGIN_MAIN_SHA="$(git rev-parse "$REMOTE/$MAIN")"

# ── nothing-to-do short-circuit ────────────────────────────────────────────
if git merge-base --is-ancestor "$ORIGIN_MAIN_SHA" "$ORIGIN_BRANCH_SHA"; then
  note "already current: $REMOTE/$MAIN is fully contained in $REMOTE/$BRANCH — nothing to sync."
  exit 0
fi

SYNC_COUNT="$(git rev-list --count "$ORIGIN_BRANCH_SHA".."$ORIGIN_MAIN_SHA")"
note "$MAIN has moved: $SYNC_COUNT commit(s) to sync into $BRANCH."

# ── isolated worktree ──────────────────────────────────────────────────────
WT="$(mktemp -d "${TMPDIR:-/tmp}/pc-sync.XXXXXX")"
cleanup() { git worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$WT" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "creating worktree at $WT ..."
# Check out the local platform-console branch so the push updates it too. If it
# is checked out elsewhere, git refuses — surface that clearly.
if ! git worktree add "$WT" "$BRANCH" >/dev/null 2>&1; then
  die "could not create a worktree on '$BRANCH' (is it checked out in another worktree?). Free it and retry."
fi

cd "$WT"

# ── THE STALE-BASE GUARD (mechanized) ──────────────────────────────────────
# Unconditionally reset the worktree to the ORIGIN tip. If the local branch was
# stale (the 3/3 footgun), this is what makes the merge land on the true tip.
LOCAL_SHA="$(git rev-parse HEAD)"
if [ "$LOCAL_SHA" != "$ORIGIN_BRANCH_SHA" ]; then
  note "STALE base: worktree at ${LOCAL_SHA:0:7}, origin/$BRANCH at ${ORIGIN_BRANCH_SHA:0:7} — hard-resetting to origin."
else
  note "base OK: worktree already at origin/$BRANCH (${ORIGIN_BRANCH_SHA:0:7})."
fi
git reset --hard "$REMOTE/$BRANCH" >/dev/null
# Assert the guard actually took.
[ "$(git rev-parse HEAD)" = "$ORIGIN_BRANCH_SHA" ] || die "post-reset HEAD != origin/$BRANCH (unexpected)"

# ── conflict PREVIEW (does not touch the tree) ─────────────────────────────
note "previewing merge $BRANCH <- $MAIN ..."
PREVIEW="$(git merge-tree --write-tree --messages "$REMOTE/$BRANCH" "$REMOTE/$MAIN" 2>&1 || true)"
if printf '%s\n' "$PREVIEW" | grep -q 'CONFLICT'; then
  echo "pc-sync: CONFLICT detected in preview — NOT merging. Resolve by hand:" >&2
  printf '%s\n' "$PREVIEW" | grep -i 'conflict' >&2 || true
  exit 1
fi
note "preview clean (no conflicts)."

# ── the R-SYNC merge ───────────────────────────────────────────────────────
if [ "$#" -ge 1 ] && [ -n "$1" ]; then
  MSG="$1"
else
  SUBJECTS="$(git log --format='  - %s' "$REMOTE/$BRANCH".."$REMOTE/$MAIN" | head -20)"
  MSG="R-SYNC: forward-merge $MAIN into $BRANCH

Brings $BRANCH current with $MAIN ($SYNC_COUNT commit(s)):
$SUBJECTS

$TRAILER"
fi

note "merging --no-ff ..."
if ! git merge --no-ff "$REMOTE/$MAIN" -m "$MSG" >/dev/null 2>&1; then
  echo "pc-sync: merge hit a conflict despite a clean preview — aborting, nothing pushed." >&2
  git merge --abort >/dev/null 2>&1 || true
  exit 1
fi

# Defensive: a --no-ff merge must produce a two-parent commit.
PARENTS="$(git rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')"
[ "$PARENTS" = "3" ] || die "expected a two-parent merge commit; got $((PARENTS-1)) parent(s)"

MERGE_SHA="$(git rev-parse HEAD)"

# ── push ───────────────────────────────────────────────────────────────────
note "pushing $BRANCH -> $REMOTE ..."
git push "$REMOTE" "$BRANCH" >/dev/null

note "DONE. R-SYNC merge ${MERGE_SHA:0:7} pushed to $REMOTE/$BRANCH (synced $SYNC_COUNT commit(s))."
note "parents: $(git rev-list --parents -n 1 HEAD | cut -d' ' -f2-3 | sed 's/ / + /')"
echo "$MERGE_SHA"
