# Per-organization OS isolation

Every organization gets its own Linux user, home directory, disk quota, cgroup
slice and PHP-FPM pool. One tenant's processes cannot read another tenant's
files, and one tenant cannot eat the whole VPS.

Docker is not used by this path — apps run as systemd units.

## What an organization owns

```
/home/cb-<slug>                          cb-<slug>:commitbase  2770
/home/cb-<slug>/apps/<applicationId>/sources
/home/cb-<slug>/apps/<applicationId>/logs/{out,error,build,deploy}.log
/home/cb-<slug>/apps/<applicationId>/run.sh          generated per deploy
/etc/systemd/system/cb-<slug>.slice                  CPU + memory ceiling
/etc/systemd/system/cb-<slug>-<applicationId>.service
/etc/php/<ver>/fpm/pool.d/cb-<slug>.conf             open_basedir + disable_functions
```

The home is owned by the tenant user with the backend's group, mode 2770. That
is the boundary: `other` has no bits, so tenant B cannot even traverse into
tenant A's home. The backend keeps access through the group because it has to
build and read logs.

## Install

```bash
sudo install -m 0755 runner/cb-provision-org.sh /usr/local/bin/cb-provision-org
sudo install -m 0755 runner/cb-app-unit.sh      /usr/local/bin/cb-app-unit
sudo install -m 0440 runner/cb-provision-org.sudoers /etc/sudoers.d/commitbase
sudo visudo -cf /etc/sudoers.d/commitbase
```

The sudoers file assumes the backend runs as the user `commitbase` and that a
group of the same name exists. Change both names together if yours differ
(`CB_GROUP` in the scripts' environment).

Disk quotas need the filesystem holding `/home` mounted with `usrquota` and
`quotaon` run against it; without that the scripts warn and continue.

## Enable

```bash
# backend/.env
ORG_OS_ISOLATION="true"
APP_RUNTIME="systemd"
```

Then provision every existing organization and move the app directories out of
the old flat `apps_dir`:

```bash
cd backend
npm run provision:orgs -- --dry-run   # shows what would move
npm run provision:orgs
npm run check:app-paths               # path-layout self-check
```

New organizations are provisioned automatically at `POST /api/organizations` —
the OS user is created before the row, so an org can never exist without a home.

## When provisioning runs

| Trigger | What happens |
|---|---|
| `POST /api/organizations` (an org is created) | The OS user is provisioned **before** the row is written. If provisioning fails the request returns 500 and no organization is created — an org can never exist without a home |
| First-ever registration (`POST /api/auth/register`) | The bootstrap `default` organization is provisioned too, but a failure is logged and ignored so the very first login cannot be locked out. Re-run it from `/admin` |
| `POST /api/admin/organizations/:id/provision` | Manual re-run. This is the **Provision / Re-provision** button on `/admin` → Organizations |
| `npm run provision:orgs` | Bulk run over every organization, plus the move of app directories out of the old flat `apps_dir` |

The script is idempotent, so a re-run is also how you repair file ownership
after a manual edit and how you apply changed resource limits.

## Admin UI

`/admin` has three tabs:

- **Domains** — ownership assignment, as before.
- **Organizations** — every org with its isolation state, and the button that
  triggers provisioning. States: *Provisioned*, *No resource limits* (home
  exists but the cgroup slice is missing), *Not provisioned*, *Disabled*
  (`ORG_OS_ISOLATION` is off — the button is inert and a banner says why).
- **Provisioning log** — every run, newest first, with the script's own output,
  what triggered it (`org-create`, `bootstrap`, `admin`) and who clicked.

Status is read without sudo: the backend stats `/home/cb-<slug>` and
`/etc/systemd/system/cb-<slug>.slice`, so listing the page has no side effects.

Endpoints behind it, all `ADMIN` only:

```
GET  /api/admin/organizations                  # orgs + provisioning state
GET  /api/admin/organizations/:id/provision    # state for one org
POST /api/admin/organizations/:id/provision    # run it; optional { diskQuota, cpuQuota, memoryMax }
GET  /api/admin/provision-logs                 # ?organizationId= to scope
```

Runs are written to the existing `Log` model with
`metadata.scope = "provisioning"` — no new table, and they show up in whatever
log tooling already reads that table.

## Resource limits

Set per install in the backend env, applied per organization:

| Variable | Default | Effect |
|---|---|---|
| `ORG_DISK_QUOTA` | `20G` | `setquota` hard block limit on `/home` |
| `ORG_CPU_QUOTA` | `50%` | `CPUQuota=` on `cb-<slug>.slice` |
| `ORG_MEMORY_MAX` | `1G` | `MemoryMax=` on the slice, swap disabled |

The slice is org-wide, not per app: all of one tenant's apps share the ceiling,
so a tenant cannot buy more CPU by splitting one app into five.

To change limits for a single org, re-run the script with explicit arguments —
it is idempotent:

```bash
sudo cb-provision-org acme 50G 100% 2G
```

## PHP

PHP apps do not get a unit. They are served by the org's own FPM pool over
`/run/php/php<ver>-fpm-cb-<slug>.sock`, with `open_basedir` pinned to the org's
home and the process-spawning functions disabled:

```
exec, system, shell_exec, passthru, popen, proc_open, proc_nice,
proc_terminate, pcntl_exec, dl, symlink, link
```

`symlink` and `link` are on that list deliberately — without them a tenant can
link a file outside `open_basedir` and read it through the link.

Static sites also get no unit; they are served from R2 through Caddy.

## Security notes

- Nothing from the database is ever interpolated into a shell string on the way
  to a root command. `orgProvisionService` uses `execFile` with an argument
  array, and both scripts revalidate their arguments because a sudoers entry
  cannot constrain them.
- Units run with `NoNewPrivileges=true`, `ProtectSystem=strict`,
  `PrivateTmp=true` and a writable path list of exactly one directory.
- **Still open:** the Docker code path in `services/deployment.ts` builds
  `docker run` as a shell string with env var values interpolated
  (`-e ${key}=${value}`). That is a command-injection hole for anyone who can
  set an env var. It does not affect `APP_RUNTIME="systemd"`, which writes
  env vars into `run.sh` with single-quote escaping, but it should be converted
  to `execFile` before the Docker path is used again.

## Rollback

Set `APP_RUNTIME="docker"` and `ORG_OS_ISOLATION="false"`, then move the app
directories back to `APPS_DIR`. The OS users and slices are inert once nothing
references them; remove one with `userdel -r cb-<slug>` plus its slice and pool
files.
