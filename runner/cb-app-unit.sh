#!/bin/bash
# cb-app-unit — manage the systemd unit that runs one Larika application as
# its organization's OS user, inside that organization's cgroup slice.
#
# Not installed on the node: the panel sends this file's text over SSH and runs
# it as root with `bash -c <text> cb-app-unit <args>` (orgProvisionService).
#
#   cb-app-unit install <org-slug> <app-id> [source-id]
#       source-id: the directory the app's code runs from when it is not the
#       app's own — the apps of one monorepo share their source's tree. The
#       unit may write there too, and both trees are handed to the tenant.
#   cb-app-unit start|stop|restart|remove|status <org-slug> <app-id>
#   cb-app-unit chown <org-slug> <app-id>     ownership only — PHP apps have no unit
#   cb-app-unit rm-tree <org-slug> <app-id> <tree>
#       removes <app-dir>/<tree> (an old release, a build's node_modules) as root
#   cb-app-unit cancel-build <org-slug> <app-id>
#       stops that app's running build (its transient cb-build-* unit), if any
#   cb-app-unit packages <org-slug> <app-id> <key>...
#       makes sure the system packages the app needs are on this node. A key
#       from the fixed list below, never a package name: installed system-wide,
#       read-only for every tenant, and never removed (others may use them).
#   cb-app-unit build <org-slug> <app-id> [memory-max] [cpu-weight]
#       runs <app-dir>/build.sh as the build user inside cb-build.slice with a
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
CB_GROUP="${CB_GROUP:-larika}"
# Tenant build code (npm scripts, composer) runs as this user. Never the SSH
# user: that one has passwordless root, and a postinstall script would get it.
BUILD_USER="${BUILD_USER:-larika-build}"
BUILD_MEMORY_MAX="3G"
BUILD_CPU_WEIGHT="50"
SOURCE_ID="$APP_ID"
# the 4th and 5th arguments mean something different per action
case "$ACTION" in
  build)   BUILD_MEMORY_MAX="${4:-3G}"; BUILD_CPU_WEIGHT="${5:-50}" ;;
  install) SOURCE_ID="${4:-$APP_ID}" ;;
  rm-tree) TREE="${4-}" ;;
esac
# rm-tree: a path inside the app directory — plain segments, never up, never the root
[[ "$ACTION" != rm-tree || "$TREE" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ && ! "$TREE" =~ (^|/)\.\.(/|$) ]] || { echo "cb-app-unit: invalid tree: '$TREE'" >&2; exit 2; }
[[ "$BUILD_MEMORY_MAX" =~ ^[0-9]+[KMGT]?$ ]] || { echo "cb-app-unit: invalid memory max: '$BUILD_MEMORY_MAX'" >&2; exit 2; }
[[ "$BUILD_CPU_WEIGHT" =~ ^[0-9]{1,5}$ ]]    || { echo "cb-app-unit: invalid cpu weight: '$BUILD_CPU_WEIGHT'" >&2; exit 2; }
HOME_ROOT="${CB_HOME_ROOT:-/home}"

[[ "$ACTION" =~ ^(install|start|stop|restart|remove|status|chown|build|cancel-build|rm-tree|packages)$ ]] || { echo "cb-app-unit: unknown action: '$ACTION'" >&2; exit 2; }
[[ "$SLUG"   =~ ^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$ ]]            || { echo "cb-app-unit: invalid slug: '$SLUG'" >&2; exit 2; }
[[ "$APP_ID" =~ ^[A-Za-z0-9_-]{1,64}$ ]]                        || { echo "cb-app-unit: invalid app id: '$APP_ID'" >&2; exit 2; }
[[ "$SOURCE_ID" =~ ^[A-Za-z0-9_-]{1,64}$ ]]                     || { echo "cb-app-unit: invalid source id: '$SOURCE_ID'" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "cb-app-unit: must run as root" >&2; exit 2; }
if getent group commitbase >/dev/null && find "$HOME_ROOT" -maxdepth 1 -name 'cb-*' -group commitbase -print -quit | grep -q .; then
  echo "cb-app-unit: tenant homes on this node still belong to the pre-rename 'commitbase' group — run migrate-to-larika.sh on it first" >&2; exit 4
fi

OS_USER="cb-$SLUG"
HOME_DIR="$HOME_ROOT/$OS_USER"
APP_DIR="$HOME_DIR/apps/$APP_ID"
# same org's home, same id rules: never outside this tenant
SOURCE_DIR="$HOME_DIR/apps/$SOURCE_ID"
UNIT="cb-$SLUG-$APP_ID.service"
UNIT_PATH="/etc/systemd/system/$UNIT"

id -u "$OS_USER" >/dev/null 2>&1 || { echo "cb-app-unit: org not provisioned: $OS_USER" >&2; exit 3; }

hand_to_tenant() {
  local dir="$1"
  [ -d "$dir" ] || { echo "cb-app-unit: app directory missing: $dir" >&2; exit 3; }
  mkdir -p "$dir/logs"
  # The backend builds into this tree as its own user; hand it to the tenant
  # so the app can write at runtime, keeping the backend's group access.
  # Re-run after every deploy — new files land owned by the backend.
  # Only what is not the tenant's yet: a blanket chown -R / chmod -R rewrote
  # every file of every kept release (node_modules, .next) on each deploy and
  # outgrew its timeout once a few releases piled up. -h: the `current`
  # symlink itself, never through it.
  # node_modules stays the build user's: pnpm hardlinks it from its store, so a chown
  # here would hand the store's inodes to the tenant and the next install's chmod
  # fails (ERR_PNPM_CMD_SHIM_CHMOD). The app only reads it; world-readable as built.
  find "$dir" -name node_modules -prune -o \( ! -user "$OS_USER" -o ! -group "$CB_GROUP" \) -exec chown -h "$OS_USER:$CB_GROUP" {} +
  find "$dir" -name node_modules -prune -o -type f ! -perm -0060 -exec chmod g+rwX {} +
  find "$dir" -name node_modules -prune -o -type d ! -perm -2070 -exec chmod g+rwxs {} +
}

case "$ACTION" in
  packages)
    shift 3
    for KEY in "$@"; do
      # the list lives here too: a panel that sends anything else gets nothing installed
      case "$KEY" in
        libreoffice) PKGS=(libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress fonts-liberation fonts-dejavu fonts-noto-core) ;;
        *) echo "cb-app-unit: unknown system package: '$KEY'" >&2; exit 2 ;;
      esac
      MISSING=()
      for P in "${PKGS[@]}"; do
        dpkg-query -W -f='${Status}' "$P" 2>/dev/null | grep -q 'install ok installed' || MISSING+=("$P")
      done
      if [ ${#MISSING[@]} -eq 0 ]; then echo "$KEY: already installed"; continue; fi
      echo "$KEY: installing ${MISSING[*]}"
      # two deploys at once wait for each other's apt lock instead of failing;
      # a stale package index is refreshed once and tried again
      APT=(env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y -qq --no-install-recommends)
      "${APT[@]}" "${MISSING[@]}" >/dev/null || { apt-get -o DPkg::Lock::Timeout=600 update -qq && "${APT[@]}" "${MISSING[@]}" >/dev/null; }
      echo "$KEY: installed"
    done
    ;;

  chown)
    hand_to_tenant "$APP_DIR"
    echo "chowned $APP_DIR"
    ;;

  rm-tree)
    # what a build left (an old release, node_modules, dist) is the build user's,
    # with modes the backend's SSH user cannot delete through — so removed here
    rm -rf -- "$APP_DIR/$TREE"
    echo "removed $APP_DIR/$TREE"
    ;;

  build)
    [ -f "$APP_DIR/build.sh" ] || { echo "cb-app-unit: $APP_DIR/build.sh missing — the backend writes it" >&2; exit 3; }
    # --wait returns the script's exit code; --pipe streams its output to ours.
    # OOMPolicy=continue: the default (stop) SIGTERMs the whole unit after the
    # kernel kills one process, so pnpm/npm report a bare "Command failed" and
    # exit 1. Left alone, the killed process's 137 reaches the backend, which
    # names the memory limit.
    exec systemd-run --wait --pipe --collect --quiet \
      --unit="cb-build-$SLUG-$APP_ID-$$" --slice=cb-build.slice \
      --uid="$BUILD_USER" --gid="$CB_GROUP" \
      -p MemoryMax="$BUILD_MEMORY_MAX" -p MemorySwapMax=0 -p OOMScoreAdjust=500 -p OOMPolicy=continue \
      -p CPUWeight="$BUILD_CPU_WEIGHT" -p IOWeight="$BUILD_CPU_WEIGHT" -p Nice=10 \
      -p TimeoutStartSec=0 \
      -p UMask=0002 \
      /bin/bash "$APP_DIR/build.sh"
    ;;

  cancel-build)
    # the unit build) starts is cb-build-<slug>-<app>-<pid>: stop whichever is
    # running. Its --wait then returns non-zero and the backend records CANCELLED.
    systemctl stop "cb-build-$SLUG-$APP_ID-*.service" 2>/dev/null || true
    echo "cancelled builds of $APP_ID"
    ;;

  install)
    [ -f "$APP_DIR/run.sh" ] || { echo "cb-app-unit: $APP_DIR/run.sh missing — the backend writes it" >&2; exit 3; }
    hand_to_tenant "$APP_DIR"
    WRITABLE="$APP_DIR"
    if [ "$SOURCE_DIR" != "$APP_DIR" ]; then
      hand_to_tenant "$SOURCE_DIR"
      WRITABLE="$APP_DIR $SOURCE_DIR"
    fi

    cat > "$UNIT_PATH" <<UNIT_EOF
[Unit]
Description=Larika app $APP_ID ($SLUG)
After=network.target

[Service]
Type=simple
User=$OS_USER
Group=$OS_USER
Slice=cb-$SLUG.slice
# run.sh cd's into current/ (or sources/ for pre-release apps) — its source's.
WorkingDirectory=$APP_DIR
EnvironmentFile=-$APP_DIR/.env.runtime
ExecStart=/bin/bash $APP_DIR/run.sh
Restart=always
RestartSec=5
# A build in cb-build.slice may still ask for more than the box has. These two
# decide who dies then: the app keeps a reclaim-protected working set, and its
# OOM score is lowered so the kernel reaches for the build (OOMScoreAdjust=500
# there) instead of an app that is serving traffic.
MemoryLow=128M
OOMScoreAdjust=-200
StandardOutput=append:$APP_DIR/logs/out.log
StandardError=append:$APP_DIR/logs/error.log

# Hardening. NoNewPrivileges is the one that matters most: it stops any setuid
# binary inside the tenant's tree from being used to climb out.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$WRITABLE
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
RemoveIPC=true
LockPersonality=true
# AF_NETLINK: getifaddrs (os.networkInterfaces — Fastify logs its addresses
# on listen) goes through netlink; without it Node throws EAFNOSUPPORT (errno 97)
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
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
