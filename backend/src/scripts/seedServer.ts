/**
 * Create the first Server row from the environment this install already has,
 * and place every unplaced organization on it.
 *
 * The VM the control plane runs on is not special — it becomes a Server row
 * like any other, reached over SSH like any other. That is what lets the rest
 * of the code have a single path instead of a local branch.
 *
 *   npx tsx src/scripts/seedServer.ts            # create + backfill
 *   npx tsx src/scripts/seedServer.ts --dry-run
 *
 * Idempotent: re-run after adding orgs, or to repair the row from env.
 */
import 'dotenv/config';
import { prisma } from '../lib/prisma';

const DRY = process.argv.includes('--dry-run');

const NAME = process.env.SEED_SERVER_NAME || 'primary';
const HOSTNAME = process.env.SEED_SERVER_HOSTNAME || '127.0.0.1';
const SSH_USER = process.env.SEED_SERVER_SSH_USER || 'larika';
const SSH_PORT = Number(process.env.SEED_SERVER_SSH_PORT || 22);
const SSH_KEY_PATH = process.env.CB_SSH_KEY_PATH || '/opt/larika/.ssh/id_ed25519';
// SERVER_IP is what cloudflareService already used as the A record target.
const PUBLIC_IP = process.env.SERVER_IP || process.env.CLOUDFLARE_DNS_TARGET || '';

async function main() {
  if (!PUBLIC_IP) {
    throw new Error('Set SERVER_IP (or CLOUDFLARE_DNS_TARGET) — it becomes the node\'s DNS target');
  }

  const fields = {
    name: NAME,
    hostname: HOSTNAME,
    sshUser: SSH_USER,
    sshPort: SSH_PORT,
    sshKeyPath: SSH_KEY_PATH,
    publicIp: PUBLIC_IP,
  };

  console.log(DRY ? '[dry run] would seed:' : 'seeding:', fields);

  const existing = await prisma.server.findFirst({ where: { name: NAME } });
  const unplaced = await prisma.organization.count({ where: { serverId: null } });
  console.log(`${existing ? 'server exists' : 'server will be created'}; ${unplaced} unplaced organization(s)`);

  if (DRY) return;

  const server = existing
    ? await prisma.server.update({ where: { id: existing.id }, data: fields })
    : await prisma.server.create({ data: fields });

  // Only unplaced orgs. An org already on another node must never be dragged back.
  const { count } = await prisma.organization.updateMany({
    where: { serverId: null },
    data: { serverId: server.id },
  });

  console.log(`server ${server.name} (${server.id}) at ${server.sshUser}@${server.hostname}:${server.sshPort}`);
  console.log(`placed ${count} organization(s)`);
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
