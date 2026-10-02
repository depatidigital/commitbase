#!/bin/bash
# cb-renumber-org — move an organization's OS user on this node to another UID.
#
# Not installed on the node: the panel sends this file's text over SSH and runs
# it as root (orgProvisionService), when the UID another organization needs here
# is held by this one's user — a user left by a second panel or a database reset.
#
#   cb-renumber-org <org-slug> <new-uid>
#
# Its running units (apps, redis) are stopped and started again, so it is
# down for as long as the re-owning takes. The user (UID and its own group's
# GID), the files it owns in its home and the temp dirs, and its subordinate
# range with what podman stored under it all move together.

set -euo pipefail

SLUG="${1-}"
NEW="${2-}"
HOME_ROOT="${CB_HOME_ROOT:-/home}"

[[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$ ]] || { echo "cb-renumber-org: invalid slug: '$SLUG'" >&2; exit 2; }
[[ "$NEW"  =~ ^[1-9][0-9]{2,9}$ ]]                 || { echo "cb-renumber-org: invalid uid: '$NEW'" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "cb-renumber-org: must run as root" >&2; exit 2; }

OS_USER="cb-$SLUG"
HOME_DIR="$HOME_ROOT/$OS_USER"
OLD="$(id -u "$OS_USER" 2>/dev/null)" || { echo "cb-renumber-org: no user $OS_USER on this node" >&2; exit 3; }
[ "$OLD" != "$NEW" ] || { echo "$OS_USER already has UID $NEW"; exit 0; }
OWNER="$(getent passwd "$NEW" | cut -d: -f1 || true)"
[ -z "$OWNER" ] || { echo "cb-renumber-org: UID $NEW is already used by '$OWNER' on this node" >&2; exit 5; }
GROUP_OWNER="$(getent group "$NEW" | cut -d: -f1 || true)"
[ -z "$GROUP_OWNER" ] || { echo "cb-renumber-org: GID $NEW is already used by group '$GROUP_OWNER' on this node" >&2; exit 5; }
OLD_GID="$(getent group "$OS_USER" | cut -d: -f3 || true)"

# The subordinate range follows the UID (cb-provision-org derives it the same way).
range_of() { [ "$1" -ge 200000 ] && echo $(( 2000000 + ($1 - 200000) * 65536 )) || true; }
OLD_SUB="$(range_of "$OLD")"
NEW_SUB="$(range_of "$NEW")"
SUB_COUNT=65536
MOVE_SUB=
if [ -n "$OLD_SUB" ] && [ -n "$NEW_SUB" ] && grep -q "^$OS_USER:$OLD_SUB:$SUB_COUNT\$" /etc/subuid 2>/dev/null; then
  for MAP in /etc/subuid /etc/subgid; do
    OTHER="$(awk -F: -v s="$NEW_SUB" -v u="$OS_USER" '$2 == s && $1 != u { print $1 }' "$MAP" | head -1)"
    [ -z "$OTHER" ] || { echo "cb-renumber-org: $MAP already gives range $NEW_SUB to '$OTHER'" >&2; exit 5; }
  done
  MOVE_SUB=1
fi

# --- stop -------------------------------------------------------------------
ACTIVE="$(systemctl list-units "cb-$SLUG-*.service" --state=active --plain --no-legend 2>/dev/null | awk '{ print $1 }')"
for UNIT in $ACTIVE; do systemctl stop "$UNIT"; echo "stopped $UNIT"; done
# its user manager (rootless podman) and anything else still running as it
loginctl terminate-user "$OS_USER" 2>/dev/null || true
pkill -KILL -u "$OLD" 2>/dev/null || true
for _ in $(seq 1 20); do pgrep -u "$OLD" >/dev/null || break; sleep 0.5; done
pgrep -u "$OLD" >/dev/null && { echo "cb-renumber-org: processes of $OS_USER would not stop" >&2; exit 6; }

# --- move -------------------------------------------------------------------
[ -n "$OLD_GID" ] && groupmod -g "$NEW" "$OS_USER"
usermod -u "$NEW" "$OS_USER"
echo "$OS_USER: UID $OLD -> $NEW"

DIRS=("$HOME_DIR" /tmp /var/tmp)
find "${DIRS[@]}" -xdev -uid "$OLD" -exec chown -h "$NEW" {} + 2>/dev/null || true
[ -n "$OLD_GID" ] && { find "${DIRS[@]}" -xdev -gid "$OLD_GID" -exec chgrp -h "$NEW" {} + 2>/dev/null || true; }

if [ -n "$MOVE_SUB" ]; then
  # What podman stored inside the user namespace is owned by the old range.
  STORE="$HOME_DIR/.local/share/containers"
  END=$(( OLD_SUB + SUB_COUNT ))
  if [ -d "$STORE" ]; then
    find "$STORE" -xdev \( \( -uid +$(( OLD_SUB - 1 )) -uid -$END \) -o \( -gid +$(( OLD_SUB - 1 )) -gid -$END \) \) -printf '%U %G %p\0' |
      while IFS=' ' read -r -d '' U G P; do
        (( U >= OLD_SUB && U < END )) && U=$(( U - OLD_SUB + NEW_SUB ))
        (( G >= OLD_SUB && G < END )) && G=$(( G - OLD_SUB + NEW_SUB ))
        chown -h "$U:$G" "$P"
      done
  fi
  sed -i "s/^$OS_USER:$OLD_SUB:$SUB_COUNT\$/$OS_USER:$NEW_SUB:$SUB_COUNT/" /etc/subuid /etc/subgid
  echo "subuid/subgid: $OS_USER $OLD_SUB -> $NEW_SUB"
fi

# --- start ------------------------------------------------------------------
loginctl enable-linger "$OS_USER" >/dev/null 2>&1 || true
for POOL in /etc/php/*/fpm/pool.d/"$OS_USER".conf; do
  [ -f "$POOL" ] || continue
  VER="$(basename "$(dirname "$(dirname "$(dirname "$POOL")")")")"
  systemctl reload "php$VER-fpm" 2>/dev/null || systemctl restart "php$VER-fpm" 2>/dev/null || true
done
for UNIT in $ACTIVE; do systemctl start "$UNIT" && echo "started $UNIT" || echo "warning: $UNIT did not start" >&2; done
