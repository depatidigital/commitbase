#!/bin/bash
# One-time migration of a box installed under the old "commitbase" names to the
# "larika" ones. Run as root on every box: all nodes first, the panel last.
#
#   Every box (the panel's own box included, it is a node too):
#     group   commitbase -> larika            (renamed in place, same GID, so
#                                              tenant homes need no chown)
#     user    commitbase -> larika-build      (runs tenant builds; no sudo)
#     files   /etc/sudoers.d/commitbase, /etc/logrotate.d/commitbase -> .../larika
#     php     listen.group in every cb-* FPM pool
#
#   The panel box, additionally:
#     stops commitbase.service, renames the Postgres role and database,
#     moves /opt/commitbase -> /opt/larika, rewrites backend/.env and the
#     servers table, writes larika.service (the backend now runs as larika),
#     fixes the panel path in the Caddyfile, rebuilds and starts the backend.
#
# Order, in one maintenance window:
#   1. on the panel:  systemctl stop commitbase      (no deploys meanwhile)
#   2. on the panel:  sudo -u commitbase git -C /opt/commitbase/app pull
#                     (the new code; do not restart anything yet)
#   3. every other node:  copy this file over, then  sudo bash migrate-to-larika.sh
#   4. the panel:     cp /opt/commitbase/app/migrate-to-larika.sh /root/ && sudo bash /root/migrate-to-larika.sh
#
# Re-runnable: every step checks what is already done, so a run that died
# halfway is finished by running it again. Tenant apps keep running throughout -
# their units run as cb-<slug>, which nothing here touches.

set -euo pipefail

OLD=commitbase
NEW=larika
BUILD_USER=larika-build
OLD_DIR=/opt/commitbase
NEW_DIR=/opt/larika

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"

PANEL=0
if [ -f /etc/systemd/system/$OLD.service ] || [ -f /etc/systemd/system/$NEW.service ] || [ -d $OLD_DIR/app/backend ]; then
  PANEL=1
fi
note "this box: $([ $PANEL = 1 ] && echo 'panel (and node)' || echo node)"

if [ $PANEL = 1 ]; then
  APP_DIR=$([ -d $OLD_DIR/app ] && echo $OLD_DIR/app || echo $NEW_DIR/app)
  # Starting the backend on the old code after this would send runner scripts
  # that still chown to the commitbase group. Refuse before touching anything.
  [ -f "$APP_DIR/runner/larika.sudoers" ] \
    || die "$APP_DIR is still on the old code - git pull it first (as the $OLD user), then re-run"

  say "Stop the backend"
  systemctl stop $OLD 2>/dev/null || true
  systemctl stop $NEW 2>/dev/null || true
fi

# ------------------------------------------------------------------- 1. group
say "Group $OLD -> $NEW"
if getent group $OLD >/dev/null; then
  if getent group $NEW >/dev/null; then
    # Almost always the SSH user's own private group, created by useradd.
    # It has to go so the shared group can take its name.
    NEW_GID="$(getent group $NEW | cut -d: -f3)"
    OTHERS="$(awk -F: -v g="$NEW_GID" -v u="$NEW" '$4 == g && $1 != u { print $1 }' /etc/passwd)"
    [ -z "$OTHERS" ] || die "group $NEW is the primary group of: $OTHERS - move them off it by hand, then re-run"
    if id -u $NEW >/dev/null 2>&1; then
      usermod -g $OLD $NEW
      NEW_HOME="$(getent passwd $NEW | cut -d: -f6)"
      # its home's files carried the private group; hand them to the shared one
      [ -d "$NEW_HOME" ] && find "$NEW_HOME" -xdev -gid "$NEW_GID" -exec chgrp -h $OLD {} +
    fi
    groupdel $NEW
    note "removed $NEW's private group (GID $NEW_GID)"
  fi
  # Same GID: every tenant home, socket and member list follows automatically.
  groupmod -n $NEW $OLD
  note "renamed group $OLD to $NEW (GID $(getent group $NEW | cut -d: -f3))"
else
  getent group $NEW >/dev/null || die "neither group $OLD nor $NEW exists - is this a Larika box?"
  note "already done"
fi

# ------------------------------------------------------------ 2. build user
say "User $OLD -> $BUILD_USER"
if id -u $OLD >/dev/null 2>&1; then
  id -u $BUILD_USER >/dev/null 2>&1 && die "both $OLD and $BUILD_USER exist - remove one by hand, then re-run"
  if pgrep -u $OLD >/dev/null; then
    pgrep -a -u $OLD | sed 's/^/    /'
    die "processes are running as $OLD (a build?) - let them finish, then re-run"
  fi
  # Same UID: build output and /opt/nvm follow. The home moves off /opt/commitbase,
  # which on the panel is the app itself and becomes larika's below.
  usermod -l $BUILD_USER -d /var/lib/$BUILD_USER -s /usr/sbin/nologin $OLD
  note "renamed user $OLD to $BUILD_USER"
elif ! id -u $BUILD_USER >/dev/null 2>&1; then
  useradd --system --gid $NEW --no-create-home --home-dir /var/lib/$BUILD_USER --shell /usr/sbin/nologin $BUILD_USER
  note "created $BUILD_USER"
else
  note "already done"
fi
# a real home: npm and composer keep their caches there
install -d -m 0700 -o $BUILD_USER -g $NEW /var/lib/$BUILD_USER

# -------------------------------------------------- 3. sudoers, logrotate, php
say "sudoers, logrotate, PHP-FPM pools"
if [ -f /etc/sudoers.d/$OLD ]; then
  visudo -cf /etc/sudoers.d/$OLD >/dev/null || die "/etc/sudoers.d/$OLD does not validate - fix it first"
  mv /etc/sudoers.d/$OLD /etc/sudoers.d/$NEW
  note "/etc/sudoers.d/$NEW"
fi
[ -f /etc/logrotate.d/$OLD ] && mv /etc/logrotate.d/$OLD /etc/logrotate.d/$NEW && note "/etc/logrotate.d/$NEW"

# FPM resolves listen.group by name on reload, and the old name is gone now.
shopt -s nullglob
for POOL in /etc/php/*/fpm/pool.d/cb-*.conf; do
  if grep -q "^listen.group = $OLD\$" "$POOL"; then
    sed -i "s/^listen.group = $OLD\$/listen.group = $NEW/" "$POOL"
    note "$POOL"
  fi
done
for POOL_DIR in /etc/php/*/fpm; do
  VER="$(basename "$(dirname "$POOL_DIR")")"
  systemctl reload "php$VER-fpm" 2>/dev/null || systemctl restart "php$VER-fpm" 2>/dev/null || true
done
shopt -u nullglob

if [ $PANEL = 0 ]; then
  say "Done (node)"
  note "Caddy's API server block may still be named 'commitbase' - the panel handles either name."
  exit 0
fi

# ================================================================ panel only
ENV_FILE=""
for f in $OLD_DIR/app/backend/.env $NEW_DIR/app/backend/.env; do [ -f "$f" ] && ENV_FILE="$f" && break; done
[ -n "$ENV_FILE" ] || die "backend .env not found under $OLD_DIR or $NEW_DIR"

# ---------------------------------------------------------------- 4. postgres
say "Postgres"
DB_URL="$(grep -m1 '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d "\"'")"
RE='^postgres(ql)?://([^:@/]+)(:([^@]*))?@([^/:?]+)(:[0-9]+)?/([^?]+)'
[[ "$DB_URL" =~ $RE ]] || die "could not parse DATABASE_URL in $ENV_FILE"
DB_USER="${BASH_REMATCH[2]}"; DB_PASS="${BASH_REMATCH[4]}"; DB_HOST="${BASH_REMATCH[5]}"; DB_NAME="${BASH_REMATCH[7]}"

psql_root() { sudo -u postgres psql -v ON_ERROR_STOP=1 -qAt "$@"; }
sql_lit() { printf "'%s'" "${1//\'/\'\'}"; }

if [[ "$DB_HOST" != localhost && "$DB_HOST" != 127.0.0.1 ]]; then
  note "database is on $DB_HOST, not this box - rename its role/database there yourself; .env left pointing at it"
else
  if [ "$DB_USER" = $OLD ] && [ "$(psql_root -c "SELECT 1 FROM pg_roles WHERE rolname='$OLD'")" = 1 ]; then
    [ "$(psql_root -c "SELECT 1 FROM pg_roles WHERE rolname='$NEW'")" = 1 ] && die "Postgres roles $OLD and $NEW both exist"
    psql_root -c "ALTER ROLE $OLD RENAME TO $NEW;"
    # renaming clears an MD5 password (the name is its salt); set it again
    [ -n "$DB_PASS" ] && psql_root -c "ALTER ROLE $NEW PASSWORD $(sql_lit "$DB_PASS");"
    note "role $OLD -> $NEW"
  fi
  if [ "$DB_NAME" = $OLD ] && [ "$(psql_root -c "SELECT 1 FROM pg_database WHERE datname='$OLD'")" = 1 ]; then
    [ "$(psql_root -c "SELECT 1 FROM pg_database WHERE datname='$NEW'")" = 1 ] && die "databases $OLD and $NEW both exist"
    psql_root -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$OLD' AND pid <> pg_backend_pid();" >/dev/null
    psql_root -c "ALTER DATABASE $OLD RENAME TO $NEW;"
    note "database $OLD -> $NEW"
  fi
  DB_NOW=$([ "$DB_NAME" = $OLD ] && echo $NEW || echo "$DB_NAME")
  # Server rows point at the key by path, and the key is about to move.
  psql_root -d "$DB_NOW" -c "UPDATE servers SET \"sshKeyPath\" = replace(\"sshKeyPath\", '$OLD_DIR/', '$NEW_DIR/') WHERE \"sshKeyPath\" LIKE '$OLD_DIR/%';" >/dev/null
  psql_root -d "$DB_NOW" -c "UPDATE servers SET \"sshUser\" = '$NEW' WHERE \"sshUser\" = '$OLD';" >/dev/null
  STRAY="$(psql_root -d "$DB_NOW" -c "SELECT name || ': ' || \"sshKeyPath\" FROM servers WHERE \"sshKeyPath\" LIKE '%/$OLD/%';")"
  if [ -n "$STRAY" ]; then
    note "WARNING: these servers point at a key outside $NEW_DIR - fix them on the Servers page:"
    printf '%s\n' "$STRAY" | sed 's/^/      /'
  fi
fi

# ------------------------------------------------------------ 5. /opt, .env
say "$OLD_DIR -> $NEW_DIR"
if [ -d $OLD_DIR ]; then
  [ -e $NEW_DIR ] && die "both $OLD_DIR and $NEW_DIR exist - merge them by hand, then re-run"
  mv $OLD_DIR $NEW_DIR
  note "moved"
fi
chown -R $NEW:$NEW $NEW_DIR
# The build user shares the group. Secrets stay owner-only so a tenant build
# cannot read the panel's key or env - the whole point of the separate user.
[ -d $NEW_DIR/.ssh ] && chmod 0700 $NEW_DIR/.ssh && find $NEW_DIR/.ssh -type f ! -name '*.pub' -exec chmod 0600 {} +
ENV_FILE=$NEW_DIR/app/backend/.env
chmod 0600 "$ENV_FILE"

sed -i \
  -e "s#$OLD_DIR/#$NEW_DIR/#g" \
  -e "/^DATABASE_URL=/ s#://$OLD:#://$NEW:#" \
  -e "/^DATABASE_URL=/ s#/$OLD\\([?\"']\\|\$\\)#/$NEW\\1#" \
  "$ENV_FILE"
note "$ENV_FILE rewritten"
grep -n "$OLD" "$ENV_FILE" | sed 's/^/    still mentions the old name: /' || true

# ---------------------------------------------------------------- 6. systemd
say "larika.service"
if [ -f /etc/systemd/system/$OLD.service ]; then
  sed -e "s#$OLD_DIR#$NEW_DIR#g" -e "s#^User=$OLD\$#User=$NEW#" -e "s#^Group=$OLD\$#Group=$NEW#" \
    /etc/systemd/system/$OLD.service > /etc/systemd/system/$NEW.service
  systemctl disable $OLD >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/$OLD.service
  systemctl daemon-reload
  note "wrote /etc/systemd/system/$NEW.service"
fi
systemctl enable $NEW >/dev/null 2>&1

# ------------------------------------------------------------------ 7. caddy
say "Caddyfile"
CADDYFILE=/etc/caddy/Caddyfile
if [ -f $CADDYFILE ] && grep -q "$OLD_DIR/" $CADDYFILE; then
  cp $CADDYFILE $CADDYFILE.bak.$(date +%s)
  sed -i "s#$OLD_DIR/#$NEW_DIR/#g" $CADDYFILE
  caddy validate --config $CADDYFILE >/dev/null 2>&1 || die "Caddyfile did not validate - restore from $CADDYFILE.bak.*"
  # Drops tenant routes; the backend re-applies them on start, below.
  systemctl reload caddy || systemctl restart caddy
  note "panel path updated, Caddy reloaded"
else
  note "nothing to change"
fi

# --------------------------------------------------------- 8. build, start
say "Build and start"
sudo -u $NEW -H bash -c "
  set -e
  cd '$NEW_DIR/app/backend' && npm ci --no-audit --no-fund --silent && npx prisma generate >/dev/null && npm run build --silent
  npx prisma db push --skip-generate >/dev/null
  cd '$NEW_DIR/app/frontend' && npm ci --no-audit --no-fund --silent && npm run build --silent
"
systemctl start $NEW

PORT="$(grep -m1 '^PORT=' "$ENV_FILE" | cut -d= -f2- | tr -d "\"'")"
for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${PORT:-3001}/health" >/dev/null 2>&1 && break
  sleep 1
  [ "$i" = 30 ] && die "backend did not answer - journalctl -u $NEW -n 50"
done

say "Done (panel)"
cat <<EOF
    Backend:   systemctl status $NEW   /   journalctl -u $NEW -f
    App dir:   $NEW_DIR/app
    Check:     sudo -u $NEW ssh -i $NEW_DIR/.ssh/id_ed25519 $NEW@127.0.0.1 sudo -n true
    Caddy routes were re-applied on start ("Caddy routes re-applied: N ok").
EOF
