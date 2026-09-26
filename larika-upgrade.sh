#!/bin/bash
# Upgrade the Larika panel on this box without failing a deploy on the way.
# Run as root on the panel:
#
#   sudo bash /opt/larika/repo/larika-upgrade.sh              # newest main
#   sudo bash /opt/larika/repo/larika-upgrade.sh --branch dev
#   sudo bash /opt/larika/repo/larika-upgrade.sh --rollback   # back to the release before
#
# Options: --force (don't wait for running deploys; they fail, as a plain
# restart does), --timeout <minutes> (default 30).
#
# Layout, made on the first run from the old /opt/larika/app checkout:
#   repo/                the git clone: fetched, never built in
#   releases/<sha>/      one built tree per version; releases/initial is the
#                        checkout that was live before the first run
#   current -> releases/<sha>
#   app -> current       so larika.service and the Caddy site need no edit
#   shared/backend.env   linked into every release as backend/.env
#   shared/frontend.env  linked as frontend/.env (read by the frontend build)
#
# Steps:
#   1. fetch and build the new release beside the live one; the panel keeps serving
#   2. prisma db push WITHOUT --accept-data-loss: a destructive schema change
#      stops the upgrade here, before anything switched. Schema changes must be
#      additive — the old code runs against the new schema until the restart,
#      and a rollback does not undo them.
#   3. drain (backend/src/lib/drain.ts): new deploys queue as PENDING, running
#      ones finish; queued ones start again after the restart
#   4. switch current, restart, health check; failing, back to the previous release
set -euo pipefail

BASE="${LARIKA_BASE:-/opt/larika}"
SERVICE=larika
OWNER="${LARIKA_OWNER:-larika}"
BRANCH=main
FORCE=0
ROLLBACK=0
TIMEOUT_MIN=30
KEEP=3

say() { echo "==> $*"; }
die() { echo "larika-upgrade: $*" >&2; exit 1; }
as_owner() { sudo -u "$OWNER" -H "$@"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="${2:?--branch needs a name}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --timeout) TIMEOUT_MIN="${2:?--timeout needs minutes}"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done
[ "$(id -u)" = 0 ] || die "run as root: it restarts $SERVICE.service"
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ && "$BRANCH" != -* ]] || die "bad branch name: $BRANCH"
cd "$BASE"

exec 9>"$BASE/.upgrade.lock"
flock -n 9 || die "another upgrade is running"

link_env() {
  ln -sfn "$BASE/shared/backend.env" "$1/backend/.env"
  if [ -f shared/frontend.env ]; then ln -sfn "$BASE/shared/frontend.env" "$1/frontend/.env"; fi
  chown -h "$OWNER:$OWNER" "$1/backend/.env" "$1/frontend/.env" 2>/dev/null || true
}

# ------------------------------------------------------------ first run: layout
if [ -d app ] && [ ! -L app ]; then
  say "First run: moving $BASE/app to releases/ + current"
  install -d -o "$OWNER" -g "$OWNER" -m 0750 shared releases
  [ -f shared/backend.env ] || cp -p app/backend/.env shared/backend.env
  if [ -f app/frontend/.env ] && [ ! -f shared/frontend.env ]; then cp -p app/frontend/.env shared/frontend.env; fi
  # the tree that runs now, built as it is, is the first release — the rollback target
  [ -d releases/initial ] || cp -a app releases/initial
  rm -rf releases/initial/.git
  touch releases/initial/.built
  link_env releases/initial
  ln -sfn releases/initial current
  # the running backend keeps its open files; its paths now reach the same files through app -> current
  mv app repo
  ln -s current app
fi
[ -L current ] || die "$BASE/current is missing — is this the panel box?"

PORT="$(sed -n 's/^PORT=["'\'']\{0,1\}\([0-9]*\).*/\1/p' shared/backend.env | tail -1)"
PORT="${PORT:-3001}"
healthy() {
  for _ in $(seq 1 30); do
    curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

undrain() { rm -f shared/drain shared/drain.idle; }
# Nothing started to deploy while it waited: running ones finished, new ones queued.
drain() {
  if [ "$FORCE" = 1 ]; then say "--force: not waiting for running deploys"; return; fi
  if ! systemctl is-active --quiet "$SERVICE"; then return; fi
  rm -f shared/drain.idle
  install -o "$OWNER" -g "$OWNER" -m 0644 /dev/null shared/drain
  trap undrain EXIT
  say "Draining: new deploys queue, waiting for running ones (up to $TIMEOUT_MIN min)"
  local waited=0
  until [ -f shared/drain.idle ]; do
    if [ "$waited" -ge $((TIMEOUT_MIN * 60)) ]; then
      die "deploys still running after $TIMEOUT_MIN min — nothing switched, queued deploys start now. Retry later, or --force"
    fi
    sleep 5
    waited=$((waited + 5))
  done
}

# stop first, then lift the drain: lifted while the old process runs, it would start the queue just to be killed
switch_to() {
  ln -sfn "$1" current.new
  mv -T current.new current
  systemctl stop "$SERVICE"
  undrain
  systemctl start "$SERVICE"
}

LIVE="$(readlink current)"

# ------------------------------------------------------------ rollback
if [ "$ROLLBACK" = 1 ]; then
  PREV="$(cat shared/previous 2>/dev/null || true)"
  [ -n "$PREV" ] && [ -f "$PREV/.built" ] || die "no previous release to go back to"
  [ "$PREV" != "$LIVE" ] || die "already on $PREV"
  drain
  say "Back to $PREV (schema changes made since stay)"
  switch_to "$PREV"
  echo "$LIVE" > shared/previous
  healthy || die "$PREV does not answer on :$PORT/health either — journalctl -u $SERVICE"
  say "Done: $PREV is live"
  exit 0
fi

# ------------------------------------------------------------ build
say "Fetching $BRANCH"
as_owner git -C repo fetch --quiet origin "$BRANCH"
SHA="$(as_owner git -C repo rev-parse FETCH_HEAD)"
REL="releases/$SHA"
if [ "$REL" = "$LIVE" ]; then say "Already on ${SHA:0:7}"; exit 0; fi

if [ ! -f "$REL/.built" ]; then
  say "Building ${SHA:0:7} in $BASE/$REL — the panel keeps serving"
  rm -rf "$REL"
  install -d -o "$OWNER" -g "$OWNER" -m 0750 "$REL"
  as_owner bash -c 'git -C "$1" archive "$2" | tar -x -C "$3"' _ "$BASE/repo" "$SHA" "$BASE/$REL"
  link_env "$REL"
  # one && chain: set -e does not stop inside one, so a failed backend would go on to the frontend
  as_owner bash -c 'cd "$1/backend" && npm ci && npx prisma generate && npm run build &&
    cd "$1/frontend" && npm ci && npm run build' _ "$BASE/$REL" \
    || die "the build of ${SHA:0:7} failed — nothing switched; ${LIVE#releases/} keeps serving"
  # tabs opened before the switch still load their lazy chunks
  as_owner cp -rn "$BASE/$LIVE/frontend/dist/assets/." "$BASE/$REL/frontend/dist/assets/" 2>/dev/null || true
  touch "$REL/.built"
fi

say "Schema (no data loss allowed)"
as_owner bash -c 'cd "$1/backend" && npx prisma db push --skip-generate' _ "$BASE/$REL" \
  || die "prisma db push refused — the schema change would lose data. Nothing switched; ${LIVE#releases/} keeps serving"

# ------------------------------------------------------------ switch
drain
say "Switching to ${SHA:0:7}"
switch_to "$REL"
echo "$LIVE" > shared/previous
if ! healthy; then
  say "${SHA:0:7} does not answer on :$PORT/health — back to $LIVE"
  switch_to "$LIVE"
  echo "$REL" > shared/previous
  healthy || die "$LIVE does not answer either — journalctl -u $SERVICE"
  die "upgrade rolled back; ${SHA:0:7} is kept in $BASE/$REL (journalctl -u $SERVICE for why)"
fi

# old releases: the live one, the one before and the newest $KEEP stay
for old in $(ls -1dt releases/*/ | sed 's#/$##' | tail -n +$((KEEP + 1))); do
  [ "$old" = "$REL" ] || [ "$old" = "$LIVE" ] || rm -rf "$old"
done
say "Done: ${SHA:0:7} is live (previous: ${LIVE#releases/}; --rollback goes back to it)"
