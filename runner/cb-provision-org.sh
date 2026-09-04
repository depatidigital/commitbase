#!/bin/bash
# cb-provision-org — create the isolated OS user, home, cgroup slice and PHP-FPM
# pool for one CommitBase organization.
#
# Install to /usr/local/bin/cb-provision-org, owned root:root, mode 0755.
# Runs as root via a single NOPASSWD sudoers entry (runner/cb-provision-org.sudoers).
# Idempotent: re-run to repair ownership or change quota / resource limits.
#
#   cb-provision-org <org-slug> [quota] [cpu-quota] [memory-max]
#     quota       disk, e.g. 20G, 512M      (default 20G)
#     cpu-quota   cgroup, e.g. 30%, 150%    (default 50%)
#     memory-max  cgroup, e.g. 512M, 2G     (default 1G)
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
CB_GROUP="${CB_GROUP:-commitbase}"
HOME_ROOT="${CB_HOME_ROOT:-/home}"

# Validate here as well as in the caller — this script runs as root and a
# sudoers entry cannot constrain arguments.
[[ "$SLUG"      =~ ^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$ ]] || { echo "cb-provision-org: invalid slug: '$SLUG'" >&2; exit 2; }
[[ "$QUOTA"     =~ ^[0-9]+[MG]$ ]]                      || { echo "cb-provision-org: invalid quota: '$QUOTA'" >&2; exit 2; }
[[ "$CPU_QUOTA" =~ ^[0-9]+%$ ]]                         || { echo "cb-provision-org: invalid cpu quota: '$CPU_QUOTA'" >&2; exit 2; }
[[ "$MEM_MAX"   =~ ^[0-9]+[MG]$ ]]                      || { echo "cb-provision-org: invalid memory max: '$MEM_MAX'" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "cb-provision-org: must run as root" >&2; exit 2; }
getent group "$CB_GROUP" >/dev/null || { echo "cb-provision-org: backend group '$CB_GROUP' does not exist" >&2; exit 2; }

OS_USER="cb-$SLUG"
HOME_DIR="$HOME_ROOT/$OS_USER"
SLICE="cb-$SLUG.slice"

# --- 1. OS user -------------------------------------------------------------
if ! id -u "$OS_USER" >/dev/null 2>&1; then
  # No login shell: this account owns files and runs app processes, it is not
  # for interactive access. Switch to /bin/bash only when deliberately handing
  # a client SFTP/SSH.
  useradd --create-home --home-dir "$HOME_DIR" --shell /usr/sbin/nologin "$OS_USER"
  echo "created user $OS_USER"
else
  echo "user $OS_USER already exists"
fi

mkdir -p "$HOME_DIR/apps"
chown -R "$OS_USER:$CB_GROUP" "$HOME_DIR"
# setgid so anything the org user writes stays group-readable by the backend
chmod 2770 "$HOME_DIR" "$HOME_DIR/apps"

# Long-running user units need lingering, and PHP-FPM/systemd need the home.
loginctl enable-linger "$OS_USER" >/dev/null 2>&1 || true

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
Description=CommitBase organization $SLUG
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
