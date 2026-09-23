#!/bin/bash
# cb-provision-org — create the isolated OS user, home, cgroup slice and PHP-FPM
# pool for one Larika organization.
#
# Not installed on the node: the panel sends this file's text over SSH and runs
# it as root with `bash -c <text> cb-provision-org <args>` (orgProvisionService).
# Idempotent: re-run to repair ownership or change quota / resource limits.
#
#   cb-provision-org <org-slug> [quota] [cpu-quota] [memory-max] [uid]
#     quota       disk, e.g. 20G, 512M      (default 20G)
#     cpu-quota   cgroup, e.g. 30%, 150%    (default 50%)
#     memory-max  cgroup, e.g. 512M, 2G     (default 1G)
#     uid         the org's UID, the same on every node (the panel assigns it).
#                 Omitted: useradd picks one — fine for a single box by hand.
#
# Produces:
#   /home/cb-<slug>                       cb-<slug>:<backend-group>  2770
#   /home/cb-<slug>/apps                  cb-<slug>:<backend-group>  2770
#   /etc/systemd/system/cb-<slug>.slice   CPU + memory cap for every app of this org
#   /etc/php/<ver>/fpm/pool.d/cb-<slug>.conf   (only if PHP-FPM is installed)
#
# Home is owned by the org's own user; the group is the backend's group so the
# control plane can read/write. "Other" is stripped, so one org's user cannot
# read another's files.

set -euo pipefail

SLUG="${1-}"
QUOTA="${2-20G}"
CPU_QUOTA="${3-50%}"
MEM_MAX="${4-1G}"
ORG_UID="${5-}"
CB_GROUP="${CB_GROUP:-larika}"
HOME_ROOT="${CB_HOME_ROOT:-/home}"

# Validate here as well as in the caller — this script runs as root.
[[ "$SLUG"      =~ ^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$ ]] || { echo "cb-provision-org: invalid slug: '$SLUG'" >&2; exit 2; }
[[ "$QUOTA"     =~ ^[0-9]+[MG]$ ]]                      || { echo "cb-provision-org: invalid quota: '$QUOTA'" >&2; exit 2; }
[[ "$CPU_QUOTA" =~ ^[0-9]+%$ ]]                         || { echo "cb-provision-org: invalid cpu quota: '$CPU_QUOTA'" >&2; exit 2; }
[[ "$MEM_MAX"   =~ ^[0-9]+[MG]$ ]]                      || { echo "cb-provision-org: invalid memory max: '$MEM_MAX'" >&2; exit 2; }
[[ -z "$ORG_UID" || "$ORG_UID" =~ ^[1-9][0-9]{2,9}$ ]]  || { echo "cb-provision-org: invalid uid: '$ORG_UID'" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "cb-provision-org: must run as root" >&2; exit 2; }
# Provisioning onto the old group would split this node's tenants across two.
if getent group commitbase >/dev/null && find "$HOME_ROOT" -maxdepth 1 -name 'cb-*' -group commitbase -print -quit | grep -q .; then
  echo "cb-provision-org: tenant homes on this node still belong to the pre-rename 'commitbase' group — run migrate-to-larika.sh on it first" >&2; exit 4
fi

# A bare node has no install step, so the group and the build user are made
# here: the group grants the panel file access, the user runs builds (cb-app-unit).
BUILD_USER="${BUILD_USER:-larika-build}"
getent group "$CB_GROUP" >/dev/null || { groupadd --system "$CB_GROUP"; echo "created group $CB_GROUP"; }
if ! id -u "$BUILD_USER" >/dev/null 2>&1; then
  # A real home: npm and composer keep their caches there.
  useradd --system --gid "$CB_GROUP" --create-home --home-dir "/var/lib/$BUILD_USER" --shell /usr/sbin/nologin "$BUILD_USER"
  chmod 0700 "/var/lib/$BUILD_USER"
  echo "created user $BUILD_USER"
fi

OS_USER="cb-$SLUG"
HOME_DIR="$HOME_ROOT/$OS_USER"
SLICE="cb-$SLUG.slice"

# --- 1. OS user -------------------------------------------------------------
if ! id -u "$OS_USER" >/dev/null 2>&1; then
  UID_ARGS=()
  if [ -n "$ORG_UID" ]; then
    # Same UID (and GID) on every node, so files keep their owner between nodes.
    # A number already taken here is a local account's — refuse, never share it.
    OWNER="$(getent passwd "$ORG_UID" | cut -d: -f1 || true)"
    [ -z "$OWNER" ] || { echo "cb-provision-org: UID $ORG_UID is already used by '$OWNER' on this node" >&2; exit 5; }
    GROUP_OWNER="$(getent group "$ORG_UID" | cut -d: -f1 || true)"
    if [ -z "$GROUP_OWNER" ]; then
      groupadd --gid "$ORG_UID" "$OS_USER"
    elif [ "$GROUP_OWNER" != "$OS_USER" ]; then
      echo "cb-provision-org: GID $ORG_UID is already used by group '$GROUP_OWNER' on this node" >&2; exit 5
    fi
    UID_ARGS=(--uid "$ORG_UID" --gid "$OS_USER")
  fi
  # No login shell: this account owns files and runs app processes, it is not
  # for interactive access. Switch to /bin/bash only when deliberately handing
  # a client SFTP/SSH.
  useradd "${UID_ARGS[@]}" --create-home --home-dir "$HOME_DIR" --shell /usr/sbin/nologin "$OS_USER"
  echo "created user $OS_USER (uid $(id -u "$OS_USER"))"
else
  CURRENT_UID="$(id -u "$OS_USER")"
  if [ -n "$ORG_UID" ] && [ "$CURRENT_UID" != "$ORG_UID" ]; then
    # Renumbering a live user means stopping its apps and re-owning its files:
    # a deliberate maintenance step, not something to do in passing.
    echo "cb-provision-org: $OS_USER exists here with UID $CURRENT_UID, but the organization's UID is $ORG_UID — renumber it (usermod -u $ORG_UID $OS_USER, with its apps stopped)" >&2
    exit 5
  fi
  echo "user $OS_USER already exists (uid $CURRENT_UID)"
fi

mkdir -p "$HOME_DIR/apps"
# node_modules stays the build user's (see cb-app-unit hand_to_tenant): pnpm
# hardlinks it from its store, so chowning it hands the store's inodes to the
# tenant and every later install fails with ERR_PNPM_CMD_SHIM_CHMOD.
# .local/share/containers is left alone for the same shape of reason: it is
# podman's layer store, hardlinked and deliberately owned across a user
# namespace, and chowning it corrupts it.
find "$HOME_DIR" \( -name node_modules -o -path "$HOME_DIR/.local/share/containers" \) -prune -o \( ! -user "$OS_USER" -o ! -group "$CB_GROUP" \) -exec chown -h "$OS_USER:$CB_GROUP" {} +
# setgid so anything the org user writes stays group-readable by the backend
chmod 2770 "$HOME_DIR" "$HOME_DIR/apps"

# Long-running user units need lingering, and PHP-FPM/systemd need the home.
# Also what starts this user's systemd manager and creates /run/user/<uid>,
# which rootless podman needs, so the podman block below checks it took.
loginctl enable-linger "$OS_USER" >/dev/null 2>&1 || true

# --- 1b. rootless containers ------------------------------------------------
# Only on a node set up with WITH_PODMAN. An org's stacks run as its own user,
# in a user namespace, which needs a subordinate UID/GID range. The range is
# derived from the org's UID rather than allocated: same range on every node,
# for the same reason the UID is the same on every node. A range that is
# already someone else's is refused, never shared — as with the UID above.
if command -v podman >/dev/null 2>&1; then
  if [ -z "$ORG_UID" ] || [ "$ORG_UID" -lt 200000 ]; then
    # Orgs from before the panel assigned UIDs: useradd picked the number, so
    # there is nothing stable to derive from. Said, not fatal — everything but
    # compose apps works fine for them.
    echo "warning: $OS_USER has no panel-assigned UID, so no subuid range — compose apps will not run for this org" >&2
  else
    SUB_START=$(( 2000000 + (ORG_UID - 200000) * 65536 ))
    SUB_COUNT=65536
    for MAP in /etc/subuid /etc/subgid; do
      [ -f "$MAP" ] || : > "$MAP"
      MINE="$(grep -c "^$OS_USER:" "$MAP" || true)"
      if [ "$MINE" -gt 0 ]; then
        grep -q "^$OS_USER:$SUB_START:$SUB_COUNT\$" "$MAP" \
          || echo "warning: $MAP already maps $OS_USER to a different range — left as it is" >&2
        continue
      fi
      OTHER="$(awk -F: -v s="$SUB_START" '$2 == s { print $1 }' "$MAP" | head -1)"
      [ -z "$OTHER" ] || { echo "cb-provision-org: $MAP already gives range $SUB_START to '$OTHER'" >&2; exit 5; }
      printf '%s:%s:%s\n' "$OS_USER" "$SUB_START" "$SUB_COUNT" >> "$MAP"
    done
    echo "subuid/subgid: $OS_USER $SUB_START+$SUB_COUNT"

    # Podman's layer store: the user's own group and no setgid. The home is
    # 2770 group $CB_GROUP, which every directory under it would inherit — and
    # inside the user namespace that group is not mapped, so the kernel refuses
    # the overlay mount ("failed to mount overlay for metacopy check ...
    # permission denied") and podman.service dies until the socket gives up.
    # A store made under the setgid home never held a layer (no mount ever
    # worked), so fixing its group and mode in place loses nothing.
    STORE="$HOME_DIR/.local/share/containers"
    install -d -o "$OS_USER" -g "$CB_GROUP" -m 2770 "$HOME_DIR/.local" "$HOME_DIR/.local/share"
    if [ ! -d "$STORE" ]; then
      install -d -o "$OS_USER" -g "$OS_USER" -m 0700 "$STORE"
    elif [ -g "$STORE" ] || [ "$(stat -c %G "$STORE")" != "$OS_USER" ]; then
      chgrp -R "$OS_USER" "$STORE"
      find "$STORE" -type d -perm -2000 -exec chmod g-s {} +
      chmod 0700 "$STORE"
      echo "podman store of $OS_USER: own group, no setgid"
    fi

    # The compose CLI talks to this user's own podman socket (see cb-compose,
    # written by install.sh). Enabling it here also proves the user manager is
    # up, which is the part lingering is responsible for. reset-failed first:
    # a socket that hit its trigger limit stays failed until told otherwise.
    RUN_DIR="/run/user/$(id -u "$OS_USER")"
    if [ -d "$RUN_DIR" ]; then
      runuser -u "$OS_USER" -- env "XDG_RUNTIME_DIR=$RUN_DIR" "DBUS_SESSION_BUS_ADDRESS=unix:path=$RUN_DIR/bus" \
        systemctl --user reset-failed podman.socket podman.service >/dev/null 2>&1 || true
      runuser -u "$OS_USER" -- env "XDG_RUNTIME_DIR=$RUN_DIR" "DBUS_SESSION_BUS_ADDRESS=unix:path=$RUN_DIR/bus" \
        systemctl --user enable --now podman.socket >/dev/null 2>&1 \
        && echo "podman socket enabled for $OS_USER" \
        || echo "warning: could not enable podman.socket for $OS_USER — compose apps will not start" >&2
    else
      echo "warning: $RUN_DIR does not exist — lingering did not take, so rootless podman cannot run" >&2
    fi
  fi
fi

# --- 2. Disk quota ----------------------------------------------------------
# Best effort. Needs quotas enabled on the filesystem holding $HOME_ROOT
# (ext4: usrquota mount option + quotaon; xfs: uquota).
QUOTA_NUM="${QUOTA%[MG]}"
if [ "${QUOTA: -1}" = "G" ]; then BLOCKS=$((QUOTA_NUM * 1024 * 1024)); else BLOCKS=$((QUOTA_NUM * 1024)); fi

if command -v setquota >/dev/null 2>&1 && setquota -u "$OS_USER" 0 "$BLOCKS" 0 0 "$HOME_ROOT" 2>/dev/null; then
  echo "quota set: $QUOTA on $HOME_ROOT"
else
  echo "warning: quota not applied — install quota tools and enable usrquota on $HOME_ROOT" >&2
fi

# --- 3. cgroup slice --------------------------------------------------------
# Every app unit for this org sets Slice=cb-<slug>.slice, so the caps below are
# an org-wide ceiling: one runaway app cannot starve the other tenants.
cat > "/etc/systemd/system/$SLICE" <<SLICE_EOF
[Unit]
Description=Larika organization $SLUG
Before=slices.target

[Slice]
CPUAccounting=true
CPUQuota=$CPU_QUOTA
MemoryAccounting=true
MemoryMax=$MEM_MAX
MemorySwapMax=0
TasksAccounting=true
TasksMax=512
IOAccounting=true
SLICE_EOF

systemctl daemon-reload
systemctl start "$SLICE" || true
echo "slice $SLICE: CPUQuota=$CPU_QUOTA MemoryMax=$MEM_MAX"

# --- 4. PHP-FPM pool --------------------------------------------------------
# One pool per org, shared by that org's PHP apps. Skipped when PHP-FPM is not
# installed. open_basedir is the boundary that stops PHP reading another tenant.
shopt -s nullglob
for POOL_DIR in /etc/php/*/fpm/pool.d; do
  PHP_VER="$(echo "$POOL_DIR" | cut -d/ -f4)"
  cat > "$POOL_DIR/$OS_USER.conf" <<POOL_EOF
[$OS_USER]
user = $OS_USER
group = $OS_USER
listen = /run/php/php$PHP_VER-fpm-$OS_USER.sock
listen.owner = $OS_USER
listen.group = $CB_GROUP
listen.mode = 0660

pm = ondemand
pm.max_children = 10
pm.process_idle_timeout = 30s
pm.max_requests = 500

; Confine PHP to this tenant's home. This is the isolation boundary.
php_admin_value[open_basedir] = $HOME_DIR:/tmp
php_admin_value[upload_tmp_dir] = $HOME_DIR/tmp
php_admin_value[sys_temp_dir] = $HOME_DIR/tmp
php_admin_value[session.save_path] = $HOME_DIR/tmp
php_admin_value[error_log] = $HOME_DIR/logs/php-error.log
php_admin_flag[log_errors] = on
php_admin_flag[display_errors] = off

; Escape vectors. Removing any of these hands a tenant shell on the host.
php_admin_value[disable_functions] = exec,system,shell_exec,passthru,popen,proc_open,proc_nice,proc_terminate,pcntl_exec,dl,symlink,link
POOL_EOF
  mkdir -p "$HOME_DIR/tmp" "$HOME_DIR/logs"
  chown "$OS_USER:$CB_GROUP" "$HOME_DIR/tmp" "$HOME_DIR/logs"
  chmod 2770 "$HOME_DIR/tmp" "$HOME_DIR/logs"
  systemctl reload "php$PHP_VER-fpm" 2>/dev/null || systemctl restart "php$PHP_VER-fpm" 2>/dev/null || true
  echo "php-fpm pool: $POOL_DIR/$OS_USER.conf -> /run/php/php$PHP_VER-fpm-$OS_USER.sock"
done
shopt -u nullglob

echo "provisioned $OS_USER at $HOME_DIR"
