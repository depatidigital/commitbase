#!/usr/bin/env bash
# Offsite backup of one server: every MySQL/MariaDB and PostgreSQL database,
# Stalwart mail, and /etc — to an R2 bucket with restic (encrypted, deduplicated).
# Runbook: ops/offsite-backup.md
#
#   offsite-backup.sh install    as root: restic, the env file, a nightly timer
#   offsite-backup.sh run        one backup now (what the timer runs)
#   offsite-backup.sh snapshots  what is in the bucket
set -uo pipefail

ENV_FILE=/etc/offsite-backup.env
RESTIC_VERSION=0.17.3
# 19:00 UTC = 02:00 WIB
ON_CALENDAR='*-*-* 19:00:00 UTC'

die() { echo "offsite-backup: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root"

load_env() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE missing — run install first"
  # shellcheck source=/dev/null
  set -a; . "$ENV_FILE"; set +a
  : "${RESTIC_REPOSITORY:?set in $ENV_FILE}" "${RESTIC_PASSWORD:?set in $ENV_FILE}"
  : "${AWS_ACCESS_KEY_ID:?set in $ENV_FILE}" "${AWS_SECRET_ACCESS_KEY:?set in $ENV_FILE}"
}

install_restic() {
  if command -v restic >/dev/null && restic version | grep -qE 'restic 0\.(1[7-9]|[2-9][0-9])|restic [1-9]'; then return; fi
  local arch; case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; *) die "unsupported arch $(uname -m)" ;; esac
  local base="https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}" file="restic_${RESTIC_VERSION}_linux_${arch}.bz2"
  local tmp; tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/$file" "$base/$file" && curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || die "download failed"
  (cd "$tmp" && grep " $file\$" SHA256SUMS | sha256sum -c -) || die "restic checksum mismatch"
  bunzip2 -c "$tmp/$file" > /usr/local/bin/restic && chmod 755 /usr/local/bin/restic
  rm -rf "$tmp"
}

cmd_install() {
  install_restic
  install -m 700 "$0" /usr/local/sbin/offsite-backup
  if [ ! -f "$ENV_FILE" ]; then
    umask 077
    cat > "$ENV_FILE" <<'EOF'
# offsite-backup settings. Keep RESTIC_PASSWORD in the password manager too:
# without it the backup cannot be read, and this server may be what is lost.
RESTIC_REPOSITORY=s3:https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com/<BUCKET>
RESTIC_PASSWORD=
# R2 API token scoped to that one bucket (Object Read & Write)
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_DEFAULT_REGION=auto
# healthchecks.io ping URL: alerts when a night fails or never runs
HC_URL=
EOF
  fi
  cat > /etc/systemd/system/offsite-backup.service <<'EOF'
[Unit]
Description=Offsite backup (databases, Stalwart mail, /etc) to R2
After=network-online.target mysql.service mariadb.service postgresql.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/offsite-backup run
Nice=10
IOSchedulingClass=idle
EOF
  cat > /etc/systemd/system/offsite-backup.timer <<EOF
[Unit]
Description=Nightly offsite backup

[Timer]
OnCalendar=$ON_CALENDAR
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now offsite-backup.timer
  echo "Installed. Next: fill $ENV_FILE, then: offsite-backup run   (the first one at a quiet hour — mail stops while it copies)"
}

FAILED=()
LOG=$(mktemp)
step() { echo "== $*"; }
fail() { echo "!! $*"; FAILED+=("$*"); }

# one database, streamed straight into restic: nothing lands on this disk
dump() { # dump <tag> <name in the snapshot> <command...>
  local tag=$1 name=$2; shift 2
  restic backup --quiet --host "$(hostname)" --tag "$tag" --stdin-filename "$name" --stdin-from-command -- "$@" || fail "$tag $name"
}

backup_mysql() {
  command -v mysql >/dev/null || return 0
  mysqladmin ping >/dev/null 2>&1 || { fail "mysql not answering"; return; }
  step mysql
  local db
  # `mysql` itself is kept: it holds the users and their grants
  for db in $(mysql -NBe 'SHOW DATABASES' | grep -vxE 'information_schema|performance_schema|sys'); do
    dump mysql "mysql/$db.sql" mysqldump --single-transaction --routines --triggers --events --databases "$db"
  done
}

backup_postgres() {
  command -v psql >/dev/null || return 0
  runuser -u postgres -- psql -Atc 'select 1' >/dev/null 2>&1 || { fail "postgres not answering"; return; }
  step postgres
  dump postgres postgres/globals.sql runuser -u postgres -- pg_dumpall --globals-only
  local db
  for db in $(runuser -u postgres -- psql -Atc 'select datname from pg_database where not datistemplate'); do
    dump postgres "postgres/$db.dump" runuser -u postgres -- pg_dump -Fc "$db"
  done
}

# Stalwart's store (RocksDB by default) is only consistent at rest: stopped
# while restic reads it. After the first run only changes go up, so minutes.
backup_stalwart() {
  local d dir="" unit
  for d in /opt/stalwart /opt/stalwart-mail; do [ -d "$d" ] && { dir=$d; break; }; done
  [ -n "$dir" ] || return 0
  unit=$(systemctl list-unit-files --no-legend 'stalwart*.service' | awk 'NR==1{print $1}')
  step "stalwart $dir ($unit)"
  local was_active=0
  if [ -n "$unit" ] && systemctl is-active --quiet "$unit"; then
    was_active=1
    systemctl stop "$unit" || { fail "could not stop $unit"; return; }
  fi
  restic backup --quiet --host "$(hostname)" --tag stalwart "$dir" || fail "stalwart files"
  # a mail server left stopped is worse than a missed backup
  [ "$was_active" = 1 ] && { systemctl start "$unit" || fail "could not start $unit again"; }
}

cmd_run() {
  load_env
  exec > >(tee "$LOG") 2>&1
  [ -n "${HC_URL:-}" ] && curl -fsS -m 10 --retry 3 -o /dev/null "$HC_URL/start"
  restic cat config >/dev/null 2>&1 || { step "init repository"; restic init || die "cannot reach or create $RESTIC_REPOSITORY"; }

  backup_mysql
  backup_postgres
  backup_stalwart
  step "/etc"
  restic backup --quiet --host "$(hostname)" --tag etc /etc || fail "/etc"

  step prune
  restic forget --quiet --prune --group-by host,tags,paths --keep-daily 7 --keep-weekly 4 --keep-monthly 6 || fail prune
  # Sundays: read back 5% of the data, so a corrupt bucket is found before it is needed
  if [ "$(date +%u)" = 7 ]; then step check; restic check --read-data-subset=5% || fail check; fi

  if [ ${#FAILED[@]} -eq 0 ]; then
    step "done"
    [ -n "${HC_URL:-}" ] && curl -fsS -m 10 --retry 3 -o /dev/null --data-binary "@$LOG" "$HC_URL"
    exit 0
  fi
  step "FAILED: ${FAILED[*]}"
  [ -n "${HC_URL:-}" ] && curl -fsS -m 10 --retry 3 -o /dev/null --data-binary "@$LOG" "$HC_URL/fail"
  exit 1
}

case "${1:-}" in
  install) cmd_install ;;
  run) cmd_run ;;
  snapshots) load_env; restic snapshots --compact ;;
  *) die "usage: $0 install | run | snapshots" ;;
esac
