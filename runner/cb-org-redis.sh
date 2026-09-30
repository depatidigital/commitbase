#!/bin/bash
# cb-org-redis — one Redis server per Larika organization on this node.
#
# Not installed on the node: sent inline over SSH and run as root, like
# cb-provision-org (orgProvisionService). Idempotent: re-run to repair it or to
# apply a new memory cap. The organization must be provisioned here first.
#
#   cb-org-redis <org-slug> <port> [maxmemory]
#     port        loopback port, fixed per organization (the panel derives it)
#     maxmemory   e.g. 128M, 1G             (default 128M)
#
# Produces:
#   /home/cb-<slug>/.redis/redis.conf     cb-<slug>:<backend-group> 0640
#   /home/cb-<slug>/.redis/password       cb-<slug>:<backend-group> 0640 — the
#                                         panel reads it back; made once, kept
#   /etc/systemd/system/cb-<slug>-redis.service   runs as cb-<slug> in its slice
#
# Isolation: its own process and data under the org's user, memory and CPU
# inside the org's slice, bound to 127.0.0.1, password required, and the
# commands that reach beyond the data (CONFIG, DEBUG, MODULE, …) removed.
# Another tenant on the node can reach the port but not past the password.

set -euo pipefail

SLUG="${1-}"
PORT="${2-}"
MAXMEM="${3-128M}"
CB_GROUP="${CB_GROUP:-larika}"
HOME_ROOT="${CB_HOME_ROOT:-/home}"

[[ "$SLUG"   =~ ^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$ ]] || { echo "cb-org-redis: invalid slug: '$SLUG'" >&2; exit 2; }
[[ "$PORT"   =~ ^[0-9]{4,5}$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || { echo "cb-org-redis: invalid port: '$PORT'" >&2; exit 2; }
[[ "$MAXMEM" =~ ^[0-9]+[MG]$ ]]                      || { echo "cb-org-redis: invalid maxmemory: '$MAXMEM'" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "cb-org-redis: must run as root" >&2; exit 2; }

OS_USER="cb-$SLUG"
HOME_DIR="$HOME_ROOT/$OS_USER"
UNIT="cb-$SLUG-redis.service"
DIR="$HOME_DIR/.redis"
id -u "$OS_USER" >/dev/null 2>&1 && [ -d "$HOME_DIR" ] \
  || { echo "cb-org-redis: $OS_USER is not provisioned on this node — provision the workspace here first" >&2; exit 3; }

# --- 1. the binary ------------------------------------------------------------
# The distro's package, used only as a binary: its own shared redis-server
# service is switched off when we are the ones who installed it. One that was
# already there may be serving something, so it is left alone.
if ! command -v redis-server >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -q redis-server >/dev/null || { apt-get update -q >/dev/null && apt-get install -y -q redis-server >/dev/null; }
  systemctl disable --now redis-server >/dev/null 2>&1 || true
  echo "installed redis-server (its shared service disabled)"
fi
REDIS_BIN="$(command -v redis-server)"

# --- 2. password and config -----------------------------------------------------
install -d -o "$OS_USER" -g "$CB_GROUP" -m 2770 "$DIR"
if [ ! -s "$DIR/password" ]; then
  # cut, not head: head closing early would SIGPIPE tr and trip pipefail
  ( umask 027; head -c 60 /dev/urandom | base64 -w0 | tr -dc 'A-Za-z0-9' | cut -c1-40 > "$DIR/password" )
  echo "generated password"
fi
chown "$OS_USER:$CB_GROUP" "$DIR/password"
chmod 0640 "$DIR/password"
PASSWORD="$(cat "$DIR/password")"

# "128M" → "128mb"
MAXMEM_REDIS="$(echo "$MAXMEM" | tr 'MG' 'mg')b"

NEW_CONF="$(mktemp)"
trap 'rm -f "$NEW_CONF"' EXIT
cat > "$NEW_CONF" <<CONF_EOF
# Written by Larika (cb-org-redis) — edits are overwritten.
bind 127.0.0.1
port $PORT
protected-mode yes
daemonize no
logfile ""
dir $DIR
dbfilename dump.rdb
appendonly no
databases 16
maxmemory $MAXMEM_REDIS
# keys with a TTL (caches) go first; keys without one (queues, sessions) are kept
maxmemory-policy volatile-lru
requirepass $PASSWORD
rename-command CONFIG ""
rename-command DEBUG ""
rename-command MODULE ""
rename-command SHUTDOWN ""
rename-command REPLICAOF ""
rename-command SLAVEOF ""
rename-command MONITOR ""
rename-command SYNC ""
rename-command PSYNC ""
rename-command ACL ""
CONF_EOF

CHANGED=0
if ! cmp -s "$NEW_CONF" "$DIR/redis.conf" 2>/dev/null; then
  install -o "$OS_USER" -g "$CB_GROUP" -m 0640 "$NEW_CONF" "$DIR/redis.conf"
  CHANGED=1
fi

# --- 3. the service -------------------------------------------------------------
NEW_UNIT="[Unit]
Description=Redis for Larika organization $SLUG
After=network.target

[Service]
User=$OS_USER
Slice=cb-$SLUG.slice
ExecStart=$REDIS_BIN $DIR/redis.conf
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
LimitNOFILE=10032

[Install]
WantedBy=multi-user.target"
if [ "$(cat "/etc/systemd/system/$UNIT" 2>/dev/null)" != "$NEW_UNIT" ]; then
  printf '%s\n' "$NEW_UNIT" > "/etc/systemd/system/$UNIT"
  systemctl daemon-reload
  CHANGED=1
fi

if ! systemctl is-active --quiet "$UNIT"; then
  # something else on our port would make Redis exit in a restart loop
  if ss -ltnH "sport = :$PORT" 2>/dev/null | grep -q .; then
    echo "cb-org-redis: port $PORT is already in use on this node" >&2; exit 4
  fi
  systemctl enable --now "$UNIT" >/dev/null 2>&1
elif [ "$CHANGED" -eq 1 ]; then
  systemctl restart "$UNIT"
fi
systemctl enable "$UNIT" >/dev/null 2>&1 || true

for _ in $(seq 1 20); do
  if REDISCLI_AUTH="$PASSWORD" redis-cli -h 127.0.0.1 -p "$PORT" ping 2>/dev/null | grep -q PONG; then
    echo "redis for $OS_USER ready on 127.0.0.1:$PORT (maxmemory $MAXMEM)"
    exit 0
  fi
  sleep 0.5
done
echo "cb-org-redis: redis did not answer on 127.0.0.1:$PORT — journalctl -u $UNIT" >&2
exit 5
