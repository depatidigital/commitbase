#!/bin/bash
# cb-app-unit — manage the systemd unit that runs one CommitBase application as
# its organization's OS user, inside that organization's cgroup slice.
#
# Install to /usr/local/bin/cb-app-unit, owned root:root, mode 0755.
# Runs as root via the NOPASSWD sudoers entry (runner/cb-provision-org.sudoers).
#
#   cb-app-unit install <org-slug> <app-id>
#   cb-app-unit start|stop|restart|remove|status <org-slug> <app-id>
#   cb-app-unit chown <org-slug> <app-id>     ownership only — PHP apps have no unit
#   cb-app-unit build <org-slug> <app-id> [memory-max] [cpu-weight]
#       runs <app-dir>/build.sh as the backend user inside cb-build.slice with a
#       memory ceiling and low CPU/IO weight, so a build cannot starve the apps
#       that are serving. Output streams back on stdout.
#
# The unit runs "/bin/bash <app-dir>/run.sh". The backend writes run.sh and
# .env.runtime into the app directory — nothing from the database is ever
# interpolated into an argv or a shell string here, so a hostile env var or
# start command cannot reach this script.

set -euo pipefail

ACTION="${1-}"
SLUG="${2-}"
APP_ID="${3-}"
CB_GROUP="${CB_GROUP:-commitbase}"
CB_USER="${CB_USER:-commitbase}"
BUILD_MEMORY_MAX="${4:-2G}"
BUILD_CPU_WEIGHT="${5:-50}"
[[ "$BUILD_MEMORY_MAX" =~ ^[0-9]+[KMGT]?$ ]] || { echo "cb-app-unit: invalid memory max: '$BUILD_MEMORY_MAX'" >&2; exit 2; }
[[ "$BUILD_CPU_WEIGHT" =~ ^[0-9]{1,5}$ ]]    || { echo "cb-app-unit: invalid cpu weight: '$BUILD_CPU_WEIGHT'" >&2; exit 2; }
HOME_ROOT="${CB_HOME_ROOT:-/home}"

[[ "$ACTION" =~ ^(install|start|stop|restart|remove|status|chown|build)$ ]] || { echo "cb-app-unit: unknown action: '$ACTION'" >&2; exit 2; }
[[ "$SLUG"   =~ ^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$ ]]            || { echo "cb-app-unit: invalid slug: '$SLUG'" >&2; exit 2; }
[[ "$APP_ID" =~ ^[A-Za-z0-9_-]{1,64}$ ]]                        || { echo "cb-app-unit: invalid app id: '$APP_ID'" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "cb-app-unit: must run as root" >&2; exit 2; }

OS_USER="cb-$SLUG"
HOME_DIR="$HOME_ROOT/$OS_USER"
APP_DIR="$HOME_DIR/apps/$APP_ID"
UNIT="cb-$SLUG-$APP_ID.service"
UNIT_PATH="/etc/systemd/system/$UNIT"

id -u "$OS_USER" >/dev/null 2>&1 || { echo "cb-app-unit: org not provisioned: $OS_USER" >&2; exit 3; }

hand_to_tenant() {
  [ -d "$APP_DIR" ] || { echo "cb-app-unit: app directory missing: $APP_DIR" >&2; exit 3; }
  mkdir -p "$APP_DIR/logs"
  # The backend builds into this tree as its own user; hand it to the tenant
  # so the app can write at runtime, keeping the backend's group access.
  # Re-run after every deploy — new files land owned by the backend.
  chown -R "$OS_USER:$CB_GROUP" "$APP_DIR"
  chmod -R g+rwX "$APP_DIR"
  find "$APP_DIR" -type d -exec chmod g+s {} +
}

case "$ACTION" in
  chown)
    hand_to_tenant
    echo "chowned $APP_DIR"
    ;;

  build)
    [ -f "$APP_DIR/build.sh" ] || { echo "cb-app-unit: $APP_DIR/build.sh missing — the backend writes it" >&2; exit 3; }
    # --wait returns the script's exit code; --pipe streams its output to ours.
    exec systemd-run --wait --pipe --collect --quiet \
      --unit="cb-build-$SLUG-$APP_ID-$$" --slice=cb-build.slice \
      --uid="$CB_USER" --gid="$CB_GROUP" \
      -p MemoryMax="$BUILD_MEMORY_MAX" -p MemorySwapMax=0 \
      -p CPUWeight="$BUILD_CPU_WEIGHT" -p IOWeight="$BUILD_CPU_WEIGHT" -p Nice=10 \
      -p TimeoutStartSec=0 \
      /bin/bash "$APP_DIR/build.sh"
    ;;

  install)
    [ -f "$APP_DIR/run.sh" ] || { echo "cb-app-unit: $APP_DIR/run.sh missing — the backend writes it" >&2; exit 3; }
    hand_to_tenant

    cat > "$UNIT_PATH" <<UNIT_EOF
[Unit]
Description=CommitBase app $APP_ID ($SLUG)
After=network.target

[Service]
Type=simple
User=$OS_USER
Group=$OS_USER
Slice=cb-$SLUG.slice
# run.sh cd's into current/ (or sources/ for pre-release apps).
WorkingDirectory=$APP_DIR
EnvironmentFile=-$APP_DIR/.env.runtime
ExecStart=/bin/bash $APP_DIR/run.sh
Restart=always
RestartSec=5
StandardOutput=append:$APP_DIR/logs/out.log
StandardError=append:$APP_DIR/logs/error.log

# Hardening. NoNewPrivileges is the one that matters most: it stops any setuid
# binary inside the tenant's tree from being used to climb out.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$APP_DIR
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
RemoveIPC=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
# Node and other JIT runtimes need writable+executable pages.
MemoryDenyWriteExecute=false

[Install]
WantedBy=multi-user.target
UNIT_EOF

    systemctl daemon-reload
    systemctl enable "$UNIT" >/dev/null 2>&1 || true
    echo "installed $UNIT"
    ;;

  start)   systemctl start "$UNIT";   echo "started $UNIT" ;;
  stop)    systemctl stop "$UNIT" || true; echo "stopped $UNIT" ;;
  restart) systemctl restart "$UNIT"; echo "restarted $UNIT" ;;

  remove)
    systemctl stop "$UNIT" 2>/dev/null || true
    systemctl disable "$UNIT" 2>/dev/null || true
    rm -f "$UNIT_PATH"
    systemctl daemon-reload
    echo "removed $UNIT"
    ;;

  status)
    # Never fail the caller on "inactive" — print the state and exit 0.
    systemctl is-active "$UNIT" 2>/dev/null || true
    ;;
esac
