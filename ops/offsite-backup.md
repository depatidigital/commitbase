# Offsite backup (vpsdatabase)

`ops/offsite-backup.sh` backs up one server every night at 02:00 WIB to a
Cloudflare R2 bucket with [restic](https://restic.net) (encrypted, deduplicated):

| What | How | In the bucket |
|---|---|---|
| MySQL / MariaDB | `mysqldump --single-transaction`, one per database, `mysql` included (users, grants) | `mysql/<db>.sql`, tag `mysql` |
| PostgreSQL | `pg_dumpall --globals-only` + `pg_dump -Fc` per database | `postgres/globals.sql`, `postgres/<db>.dump`, tag `postgres` |
| Stalwart mail | the whole `/opt/stalwart` (or `/opt/stalwart-mail`) dir, **service stopped while it reads** | tag `stalwart` |
| `/etc` | configs, certificates, systemd units | tag `etc` |

Dumps stream straight into restic, so nothing extra is written to the server's disk.
Kept: 7 daily, 4 weekly, 6 monthly. On Sundays it also reads back 5% of the data
to check the bucket. healthchecks.io alerts when a night fails or never runs.

## Setup (once, ~30 min)

1. **R2 bucket**: Cloudflare → R2 → create bucket `vpsdatabase-backup`.
   Then create an API token with **Object Read & Write**, scoped to **that bucket only**.
   Note the Access Key ID, Secret, and your account ID (from the S3 endpoint URL).
2. **healthchecks.io**: create a check with period 1 day and grace 2 hours.
   Copy its ping URL and add your email and WhatsApp/Telegram as integrations.
3. **Password**: generate one (`openssl rand -base64 32`) and store it in the password
   manager first. Without it the backup cannot be read, and the server holding the
   only copy may be the thing that is gone.
4. On the server, as root:
   ```sh
   curl -fsSLO https://raw.githubusercontent.com/<org>/commitbase/main/ops/offsite-backup.sh   # or scp it
   bash offsite-backup.sh install
   nano /etc/offsite-backup.env        # fill in repository URL, password, keys, HC_URL
   ```
   `mysqldump` runs as root over the socket (the default on Debian/Ubuntu). If root
   needs a password there, put it in `/root/.my.cnf` (`[client]` `password=…`, `chmod 600`).
5. **First run, at a quiet hour.** Mail is stopped while Stalwart's files are copied,
   and the first copy uploads everything:
   ```sh
   time offsite-backup run
   offsite-backup snapshots
   ```
   Later runs only upload changes, so the mail stop is short.
6. Check that healthchecks.io shows a green ping.

## Restore

Set the environment from the saved password and keys (on a new server, recreate
`/etc/offsite-backup.env` first), then:

```sh
set -a; . /etc/offsite-backup.env; set +a
restic snapshots --compact                       # pick what and when
```

Each database is a snapshot of its own, so `--path` picks which one `latest` means.

**A MySQL database**
```sh
restic dump --path /mysql/<db>.sql latest /mysql/<db>.sql | mysql
```
Restore `mysql/mysql.sql` first on a fresh server to bring the users back, on the same
major version.

**A PostgreSQL database**
```sh
restic dump --path /postgres/globals.sql latest /postgres/globals.sql | runuser -u postgres -- psql
restic dump --path /postgres/<db>.dump latest /postgres/<db>.dump > /tmp/<db>.dump
runuser -u postgres -- pg_restore --create -d postgres /tmp/<db>.dump
```

**Stalwart mail**
```sh
systemctl stop stalwart          # or stalwart-mail
restic restore latest --tag stalwart --target /    # puts /opt/stalwart back
systemctl start stalwart
```
On a new server, install the same Stalwart version first. Restore `/etc` selectively
(`--include /etc/letsencrypt`, the unit file) rather than over a fresh system's `/etc`.
Then point DNS (MX, A of the mail host) at the new IP. DKIM keys live in Stalwart's
store, so they come back with it.

## Restore drill (do once, then yearly)

On a throwaway VPS or local VM: restore one MySQL database, one Postgres database
and Stalwart, then log into one mailbox. Write down how long it took; that is your
real recovery time.

## Not covered

- Database engines running inside containers (Podman/Docker) are not seen. Add
  them as their own `dump` lines if any exist.
- Anything outside the databases, Stalwart and `/etc`, such as uploaded files in
  `/var/www`. Add paths to the `/etc` step if they matter.
